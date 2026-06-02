import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { NormalizedDastFinding, DastToolOptions, DastSeverity } from './types.js';

const DOCKER_IMAGE = 'byt3bl33d3r/xsstrike:latest';
const TOOL_NAME = 'xsstrike';

function normalizeXsstrikeSeverity(level: string): DastSeverity {
  const value = level.toUpperCase().trim();
  if (value.includes('HIGH') || value.includes('CRITICAL')) return 'HIGH';
  if (value.includes('MEDIUM')) return 'MEDIUM';
  if (value.includes('LOW')) return 'LOW';
  return 'MEDIUM';
}

interface XsstrikeJsonEntry {
  model?: string;
  check?: string;
  payload?: string;
  place?: string;
  param?: string;
  evidence?: string;
  vuln_type?: string;
  severity?: string;
  message?: string;
}

function parseXsstrikeJson(raw: string): NormalizedDastFinding[] {
  const findings: NormalizedDastFinding[] = [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return findings;
  }

  const entries: XsstrikeJsonEntry[] = Array.isArray(data)
    ? (data as XsstrikeJsonEntry[])
    : typeof data === 'object' && data !== null && 'vulns' in data
      ? ((data as Record<string, unknown>).vulns as XsstrikeJsonEntry[] ?? [])
      : [];

  for (const entry of entries) {
    const model = String(entry.model ?? entry.vuln_type ?? 'XSS');
    const check = String(entry.check ?? entry.message ?? '');
    const payload = String(entry.payload ?? '');
    const place = String(entry.place ?? entry.param ?? '');
    const evidence = String(entry.evidence ?? '');
    const severity = String(entry.severity ?? 'medium');

    if (!check && !payload) continue;

    findings.push({
      tool: TOOL_NAME,
      alertId: `xsstrike-${findings.length}`,
      severity: normalizeXsstrikeSeverity(severity),
      url: place || '',
      parameter: entry.param || undefined,
      payload: payload || undefined,
      evidence: evidence || undefined,
      description: `${model}: ${check}`.trim(),
      fixSuggestion: 'Sanitize and encode all user input. Use Content Security Policy headers.',
    });
  }

  return findings;
}

function parseXsstrikeTextOutput(raw: string): NormalizedDastFinding[] {
  const findings: NormalizedDastFinding[] = [];
  const lines = raw.split('\n');

  let currentPayload = '';
  let currentModel = '';
  let vulnFound = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/XSS/i.test(trimmed) && (/found|vuln|injectable/i.test(trimmed))) {
      vulnFound = true;
      currentModel = trimmed.replace(/\s*[-:]\s*/g, ': ').trim();
    }

    if (/Payload:|payload:/i.test(trimmed)) {
      currentPayload = trimmed.replace(/Payload:\s*/i, '').trim();
    }

    if (vulnFound && currentPayload) {
      findings.push({
        tool: TOOL_NAME,
        alertId: `xsstrike-${findings.length}`,
        severity: 'HIGH',
        url: '',
        payload: currentPayload,
        description: currentModel || 'Reflected XSS vulnerability found',
        fixSuggestion: 'Sanitize and encode all user input. Use Content Security Policy headers.',
      });
      currentPayload = '';
      currentModel = '';
      vulnFound = false;
    }

    if (/^[-=]+$/.test(trimmed)) {
      currentPayload = '';
      currentModel = '';
      vulnFound = false;
    }
  }

  return findings;
}

async function runDocker(targetUrl: string, opts: DastToolOptions, outputDir: string): Promise<string> {
  const networkArgs = opts.networkArgs ?? '--add-host host.docker.internal:host-gateway';
  const timeout = opts.timeout ?? 180_000;

  const cmd = [
    'docker', 'run', '--rm',
    networkArgs,
    '-v', `${outputDir}:/output`,
    DOCKER_IMAGE,
    'python', 'xsstrike.py',
    '-u', targetUrl,
    '--output', '/output/xsstrike-results.json',
    '--json-output',
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

export async function runXsstrike(
  targetUrl: string,
  opts: DastToolOptions = {},
): Promise<NormalizedDastFinding[]> {
  const outputDir = opts.outputDir ?? path.join(process.cwd(), '.pakalon', 'security', 'dast');
  await fs.mkdir(outputDir, { recursive: true });

  try {
    await runDocker(targetUrl, opts, outputDir);
  } catch (err) {
    console.warn(`[dast] Xsstrike Docker failed: ${err}. Trying native xsstrike...`);
    try {
      const nativeCmd = `python xsstrike.py -u "${targetUrl}" --output "${path.join(outputDir, 'xsstrike-results.json')}" --json-output`;
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
      console.warn('[dast] Xsstrike native fallback also failed');
      return [];
    }
  }

  const jsonPath = path.join(outputDir, 'xsstrike-results.json');
  let raw = '';
  try {
    raw = await fs.readFile(jsonPath, 'utf8');
  } catch {
    return [];
  }

  if (!raw.trim()) return [];

  if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    return parseXsstrikeJson(raw);
  }
  return parseXsstrikeTextOutput(raw);
}
