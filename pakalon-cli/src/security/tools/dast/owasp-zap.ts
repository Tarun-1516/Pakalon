import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { NormalizedDastFinding, DastToolOptions, DastSeverity } from './types.js';

const DOCKER_IMAGE = 'owasp/zap2docker-stable:latest';
const TOOL_NAME = 'owasp-zap';

function normalizeZapSeverity(riskdesc: string): DastSeverity {
  const value = riskdesc.toUpperCase();
  if (value.includes('HIGH')) return 'HIGH';
  if (value.includes('MEDIUM')) return 'MEDIUM';
  if (value.includes('LOW')) return 'LOW';
  if (value.includes('INFORMATIONAL') || value.includes('INFO')) return 'INFO';
  return 'MEDIUM';
}

function parseZapJson(raw: string): NormalizedDastFinding[] {
  const findings: NormalizedDastFinding[] = [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return findings;
  }

  const siteArr = Array.isArray(data.site) ? data.site : [];
  for (const site of siteArr) {
    const alerts = Array.isArray((site as Record<string, unknown>).alerts)
      ? ((site as Record<string, unknown>).alerts as unknown[])
      : [];
    for (const alert of alerts) {
      const a = alert as Record<string, unknown>;
      const instances = Array.isArray(a.instances) ? a.instances : [];
      const pluginId = String(a.pluginid ?? a.id ?? 'zap-unknown');
      const alertName = String(a.alert ?? a.name ?? 'ZAP Alert');
      const riskdesc = String(a.riskdesc ?? a.risk ?? 'Medium');
      const desc = String(a.desc ?? a.description ?? alertName);
      const solution = String(a.solution ?? '');
      const cweid = String(a.cweid ?? '');
      const wascid = String(a.wascid ?? '');
      const reference = String(a.reference ?? '');

      if (instances.length === 0) {
        findings.push({
          tool: TOOL_NAME,
          alertId: pluginId,
          severity: normalizeZapSeverity(riskdesc),
          url: String(a.uri ?? ''),
          description: `${alertName}: ${desc}`.trim(),
          cwe: cweid || undefined,
          cve: wascid || undefined,
          fixSuggestion: solution || reference || undefined,
        });
        continue;
      }

      for (const inst of instances) {
        const instRec = inst as Record<string, unknown>;
        findings.push({
          tool: TOOL_NAME,
          alertId: pluginId,
          severity: normalizeZapSeverity(riskdesc),
          url: String(instRec.uri ?? a.uri ?? ''),
          method: String(instRec.method ?? a.method ?? ''),
          parameter: String(instRec.param ?? ''),
          evidence: String(instRec.evidence ?? ''),
          description: `${alertName}: ${desc}`.trim(),
          cwe: cweid || undefined,
          cve: wascid || undefined,
          fixSuggestion: solution || reference || undefined,
        });
      }
    }
  }

  return findings;
}

function parseZapXml(raw: string): NormalizedDastFinding[] {
  const findings: NormalizedDastFinding[] = [];
  const alertPattern = /<alertitem>[\s\S]*?<\/alertitem>/gi;
  const alerts = raw.match(alertPattern) ?? [];
  for (const xml of alerts) {
    const extract = (tag: string): string => {
      const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m?.[1]?.trim() ?? '';
    };
    const pluginId = extract('pluginid') || 'zap-unknown';
    const alertName = extract('alert') || 'ZAP Alert';
    const riskdesc = extract('riskdesc') || 'Medium';
    const desc = extract('desc') || alertName;
    const solution = extract('solution');
    const cweid = extract('cweid');
    const uri = extract('uri');
    const param = extract('param');
    const evidence = extract('evidence');
    const method = extract('method');

    findings.push({
      tool: TOOL_NAME,
      alertId: pluginId,
      severity: normalizeZapSeverity(riskdesc),
      url: uri,
      method: method || undefined,
      parameter: param || undefined,
      evidence: evidence || undefined,
      description: `${alertName}: ${desc}`.trim(),
      cwe: cweid || undefined,
      fixSuggestion: solution || undefined,
    });
  }
  return findings;
}

async function runDocker(
  targetUrl: string,
  opts: DastToolOptions,
  outputJsonPath: string,
  outputXmlPath: string,
): Promise<string> {
  const networkArgs = opts.networkArgs ?? '--add-host host.docker.internal:host-gateway';
  const timeout = opts.timeout ?? 120_000;

  const cmd = [
    'docker', 'run', '--rm',
    networkArgs,
    '-v', `${path.dirname(outputJsonPath)}:/output`,
    DOCKER_IMAGE,
    'zap.sh', '-cmd',
    '-quickurl', targetUrl,
    '-quickout', `/output/${path.basename(outputXmlPath)}`,
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

export async function runOwaspZap(
  targetUrl: string,
  opts: DastToolOptions = {},
): Promise<NormalizedDastFinding[]> {
  const outputDir = opts.outputDir ?? path.join(process.cwd(), '.pakalon', 'security', 'dast');
  await fs.mkdir(outputDir, { recursive: true });

  const outputXmlPath = path.join(outputDir, 'zap-results.xml');
  const outputJsonPath = path.join(outputDir, 'zap-results.json');

  try {
    await runDocker(targetUrl, opts, outputJsonPath, outputXmlPath);
  } catch (err) {
    console.warn(`[dast] OWASP ZAP Docker failed: ${err}. Trying native zap...`);
    try {
      const nativeCmd = `zap.sh -cmd -quickurl "${targetUrl}" -quickout "${outputXmlPath}"`;
      await new Promise<string>((resolve, reject) => {
        const child = spawn(nativeCmd, [], {
          shell: true,
          timeout: opts.timeout ?? 120_000,
          env: { ...process.env, ...opts.env },
        });
        let stdout = '';
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.on('close', () => resolve(stdout));
        child.on('error', reject);
      });
    } catch {
      console.warn('[dast] OWASP ZAP native fallback also failed');
      return [];
    }
  }

  let rawXml = '';
  try {
    rawXml = await fs.readFile(outputXmlPath, 'utf8');
  } catch {
    return [];
  }

  return parseZapXml(rawXml);
}
