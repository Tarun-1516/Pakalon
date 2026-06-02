import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { NormalizedDastFinding, DastToolOptions, DastSeverity } from './types.js';

const DOCKER_IMAGE = 'wapiitilabs/wapiti:latest';
const TOOL_NAME = 'wapiti';

function normalizeWapitiSeverity(level: string): DastSeverity {
  const value = level.toUpperCase().trim();
  if (value === '1' || value.includes('CRITICAL') || value.includes('HIGH')) return 'HIGH';
  if (value === '2' || value.includes('MEDIUM')) return 'MEDIUM';
  if (value === '3' || value.includes('LOW')) return 'LOW';
  if (value === '4' || value.includes('INFO')) return 'INFO';
  return 'MEDIUM';
}

interface WapitiVuln {
  vuln_type?: string;
  url?: string;
  param?: string;
  info?: string;
  module?: string;
  level?: string;
  http_request?: string;
  curl_command?: string;
  solution?: string;
  reference?: string;
  cve?: string;
}

function parseWapitiJson(raw: string): NormalizedDastFinding[] {
  const findings: NormalizedDastFinding[] = [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return findings;
  }

  const categories = ['vulnerabilities', 'anomalies', 'additionals', 'warnings'];
  for (const category of categories) {
    const entries = Array.isArray(data[category]) ? (data[category] as WapitiVuln[]) : [];
    for (const entry of entries) {
      const vulnType = String(entry.vuln_type ?? category);
      const url = String(entry.url ?? '');
      const param = entry.param ?? '';
      const info = String(entry.info ?? entry.module ?? '');
      const level = String(entry.level ?? '2');
      const solution = String(entry.solution ?? '');
      const reference = String(entry.reference ?? '');
      const cve = entry.cve ?? '';

      findings.push({
        tool: TOOL_NAME,
        alertId: `wapiti-${category}-${findings.length}`,
        severity: normalizeWapitiSeverity(level),
        url,
        parameter: param || undefined,
        description: `${vulnType}: ${info}`.trim(),
        cve: cve || undefined,
        fixSuggestion: solution || reference || undefined,
      });
    }
  }

  return findings;
}

async function runDocker(targetUrl: string, opts: DastToolOptions, outputPath: string): Promise<string> {
  const networkArgs = opts.networkArgs ?? '--add-host host.docker.internal:host-gateway';
  const timeout = opts.timeout ?? 300_000;

  const cmd = [
    'docker', 'run', '--rm',
    networkArgs,
    '-v', `${path.dirname(outputPath)}:/output`,
    DOCKER_IMAGE,
    'wapiti', '-u', targetUrl,
    '-f', 'json',
    '-o', `/output/${path.basename(outputPath)}`,
    '--flush-logs',
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

export async function runWapiti(
  targetUrl: string,
  opts: DastToolOptions = {},
): Promise<NormalizedDastFinding[]> {
  const outputDir = opts.outputDir ?? path.join(process.cwd(), '.pakalon', 'security', 'dast');
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'wapiti-results.json');

  try {
    await runDocker(targetUrl, opts, outputPath);
  } catch (err) {
    console.warn(`[dast] Wapiti Docker failed: ${err}. Trying native wapiti...`);
    try {
      const nativeCmd = `wapiti -u "${targetUrl}" -f json -o "${outputPath}" --flush-logs`;
      await new Promise<string>((resolve, reject) => {
        const child = spawn(nativeCmd, [], {
          shell: true,
          timeout: opts.timeout ?? 300_000,
          env: { ...process.env, ...opts.env },
        });
        let stdout = '';
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.on('close', () => resolve(stdout));
        child.on('error', reject);
      });
    } catch {
      console.warn('[dast] Wapiti native fallback also failed');
      return [];
    }
  }

  let raw = '';
  try {
    raw = await fs.readFile(outputPath, 'utf8');
  } catch {
    return [];
  }

  if (!raw.trim()) return [];

  return parseWapitiJson(raw);
}
