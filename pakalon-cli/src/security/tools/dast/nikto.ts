import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { NormalizedDastFinding, DastToolOptions, DastSeverity } from './types.js';

const DOCKER_IMAGE = 'sullo/nikto:latest';
const TOOL_NAME = 'nikto';

function normalizeNiktoSeverity(sev: string): DastSeverity {
  const value = sev.toUpperCase().trim();
  if (value === '1' || value.includes('HIGH')) return 'HIGH';
  if (value === '2' || value.includes('MEDIUM')) return 'MEDIUM';
  if (value === '3' || value.includes('LOW')) return 'LOW';
  return 'MEDIUM';
}

function parseNiktoXml(raw: string): NormalizedDastFinding[] {
  const findings: NormalizedDastFinding[] = [];
  const itemPattern = /<item>[\s\S]*?<\/item>/gi;
  const items = raw.match(itemPattern) ?? [];

  for (const xml of items) {
    const extract = (tag: string): string => {
      const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m?.[1]?.trim() ?? '';
    };

    const description = extract('description');
    const uri = extract('uri');
    const osvdbId = extract('osvdbid');
    const osvdbEntry = extract('osvdb');
    const severity = extract('severity') || '2';
    const method = extract('method');
    const ip = extract('ip');
    const hostname = extract('hostname');

    if (!description || description.includes('OSVDB-0:')) continue;

    findings.push({
      tool: TOOL_NAME,
      alertId: osvdbId !== '0' ? `OSVDB-${osvdbId}` : `nikto-${findings.length}`,
      severity: normalizeNiktoSeverity(severity),
      url: uri || `${hostname || ip || ''}`,
      method: method || undefined,
      description,
      cve: osvdbEntry ? `OSVDB-${osvdbId}` : undefined,
      fixSuggestion: description,
    });
  }

  return findings;
}

function parseNiktoJson(raw: string): NormalizedDastFinding[] {
  const findings: NormalizedDastFinding[] = [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return findings;
  }

  const vulnerabilities = Array.isArray(data.vulnerabilities)
    ? (data.vulnerabilities as unknown[])
    : [];

  for (const vuln of vulnerabilities) {
    const v = vuln as Record<string, unknown>;
    const description = String(v.description ?? v.msg ?? '');
    const uri = String(v.uri ?? v.url ?? '');
    const method = String(v.method ?? '');
    const osvdbId = String(v.osvdbid ?? v.OSVDB ?? '');
    const severity = String(v.severity ?? v.risk ?? '2');

    if (!description) continue;

    findings.push({
      tool: TOOL_NAME,
      alertId: osvdbId ? `OSVDB-${osvdbId}` : `nikto-${findings.length}`,
      severity: normalizeNiktoSeverity(severity),
      url: uri,
      method: method || undefined,
      description,
      fixSuggestion: description,
    });
  }

  return findings;
}

async function runDocker(targetUrl: string, opts: DastToolOptions, outputPath: string): Promise<string> {
  const networkArgs = opts.networkArgs ?? '--add-host host.docker.internal:host-gateway';
  const timeout = opts.timeout ?? 180_000;

  const cmd = [
    'docker', 'run', '--rm',
    networkArgs,
    '-v', `${path.dirname(outputPath)}:/output`,
    DOCKER_IMAGE,
    'nikto', '-h', targetUrl,
    '-Format', 'xml',
    '-output', `/output/${path.basename(outputPath)}`,
    ...(opts.extraArgs ?? []),
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      shell: process.platform === 'win32',
      timeout,
      env: { ...process.env, ...opts.env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', () => resolve(stdout || stderr));
    child.on('error', (err) => reject(err));
  });
}

export async function runNikto(
  targetUrl: string,
  opts: DastToolOptions = {},
): Promise<NormalizedDastFinding[]> {
  const outputDir = opts.outputDir ?? path.join(process.cwd(), '.pakalon', 'security', 'dast');
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'nikto-results.xml');

  try {
    await runDocker(targetUrl, opts, outputPath);
  } catch (err) {
    console.warn(`[dast] Nikto Docker failed: ${err}. Trying native nikto...`);
    try {
      const nativeCmd = `nikto -h "${targetUrl}" -Format xml -output "${outputPath}"`;
      await new Promise<string>((resolve, reject) => {
        const child = spawn(nativeCmd, [], {
          shell: true,
          timeout: opts.timeout ?? 180_000,
          env: { ...process.env, ...opts.env },
        });
        let stdout = '';
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.on('close', () => resolve(stdout));
        child.on('error', reject);
      });
    } catch {
      console.warn('[dast] Nikto native fallback also failed');
      return [];
    }
  }

  let raw = '';
  try {
    raw = await fs.readFile(outputPath, 'utf8');
  } catch {
    return [];
  }

  if (raw.trim().startsWith('{')) {
    return parseNiktoJson(raw);
  }
  return parseNiktoXml(raw);
}
