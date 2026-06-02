import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { NormalizedDastFinding, DastToolOptions, DastSeverity } from './types.js';

const DOCKER_IMAGE = 'paoloo/sqlmap:latest';
const TOOL_NAME = 'sqlmap';

function normalizeSqlmapSeverity(level: string): DastSeverity {
  const value = level.toUpperCase().trim();
  if (value.includes('HIGH') || value.includes('1')) return 'HIGH';
  if (value.includes('MEDIUM') || value.includes('2')) return 'MEDIUM';
  if (value.includes('LOW') || value.includes('3')) return 'LOW';
  if (value.includes('INFO') || value.includes('4')) return 'INFO';
  return 'MEDIUM';
}

interface SqlmapLogEntry {
  level?: string;
  message?: string;
  payload?: string;
  title?: string;
  injection_point?: { parameter?: string; place?: string };
  data?: Record<string, unknown>;
}

function parseSqlmapJsonOutput(raw: string): NormalizedDastFinding[] {
  const findings: NormalizedDastFinding[] = [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return findings;
  }

  const logs: SqlmapLogEntry[] = Array.isArray(data)
    ? (data as SqlmapLogEntry[])
    : Array.isArray((data as Record<string, unknown>).log)
      ? ((data as Record<string, unknown>).log as SqlmapLogEntry[])
      : [];

  for (const entry of logs) {
    const message = String(entry.message ?? entry.title ?? '');
    const payload = String(entry.payload ?? '');
    const param = entry.injection_point?.parameter ?? entry.injection_point?.place;
    const level = String(entry.level ?? 'info');

    if (!message && !payload) continue;

    const isVuln = /injectable|vulnerable|true/i.test(message);
    findings.push({
      tool: TOOL_NAME,
      alertId: `sqlmap-${findings.length}`,
      severity: isVuln ? 'HIGH' : normalizeSqlmapSeverity(level),
      url: '',
      parameter: param || undefined,
      payload: payload || undefined,
      description: message || 'sqlmap finding',
      fixSuggestion: 'Use parameterized queries or prepared statements to prevent SQL injection.',
    });
  }

  return findings;
}

function parseSqlmapTextOutput(raw: string): NormalizedDastFinding[] {
  const findings: NormalizedDastFinding[] = [];
  const lines = raw.split('\n');

  let currentParam = '';
  let currentInjection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^Parameter:|^Parameter\b/.test(trimmed)) {
      currentParam = trimmed.replace(/^Parameter:\s*/i, '').replace(/\s*\(.*$/, '').trim();
    }

    if (/Type:|Title:|Payload:|is vulnerable/i.test(trimmed)) {
      const isVuln = /vulnerable|true positive/i.test(trimmed);
      if (isVuln) {
        currentInjection = true;
      }
    }

    if (/^Payload:/i.test(trimmed) && currentParam) {
      const payload = trimmed.replace(/^Payload:\s*/i, '').trim();
      if (currentInjection || /vulnerable/i.test(payload)) {
        findings.push({
          tool: TOOL_NAME,
          alertId: `sqlmap-${findings.length}`,
          severity: 'HIGH',
          url: '',
          parameter: currentParam,
          payload,
          description: `SQL injection found in parameter: ${currentParam}`,
          fixSuggestion: 'Use parameterized queries or prepared statements.',
        });
        currentInjection = false;
      }
    }

    if (/^(---|\[.*\]|$)/.test(trimmed) && currentParam) {
      currentParam = '';
      currentInjection = false;
    }
  }

  return findings;
}

async function runDocker(targetUrl: string, opts: DastToolOptions, outputDir: string): Promise<string> {
  const networkArgs = opts.networkArgs ?? '--add-host host.docker.internal:host-gateway';
  const timeout = opts.timeout ?? 300_000;

  const cmd = [
    'docker', 'run', '--rm',
    networkArgs,
    '-v', `${outputDir}:/output`,
    DOCKER_IMAGE,
    'python', '-m', 'sqlmap',
    '-u', targetUrl,
    '--batch',
    '--output-dir=/output',
    '--forms',
    '--crawl=2',
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

export async function runSqlmap(
  targetUrl: string,
  opts: DastToolOptions = {},
): Promise<NormalizedDastFinding[]> {
  const outputDir = opts.outputDir ?? path.join(process.cwd(), '.pakalon', 'security', 'dast');
  await fs.mkdir(outputDir, { recursive: true });

  const sqlmapDir = path.join(outputDir, 'sqlmap-output');
  await fs.mkdir(sqlmapDir, { recursive: true });

  try {
    await runDocker(targetUrl, opts, sqlmapDir);
  } catch (err) {
    console.warn(`[dast] sqlmap Docker failed: ${err}. Trying native sqlmap...`);
    try {
      const nativeCmd = `python -m sqlmap -u "${targetUrl}" --batch --output-dir="${sqlmapDir}" --forms --crawl=2`;
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
      console.warn('[dast] sqlmap native fallback also failed');
      return [];
    }
  }

  let raw = '';
  try {
    const files = await fs.readdir(sqlmapDir);
    for (const file of files) {
      const fp = path.join(sqlmapDir, file);
      if (file.endsWith('.json')) {
        raw = await fs.readFile(fp, 'utf8');
        break;
      }
      if (file.endsWith('.log')) {
        const logContent = await fs.readFile(fp, 'utf8');
        if (!raw) raw = logContent;
      }
    }
  } catch {
    return [];
  }

  if (!raw) return [];

  if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    return parseSqlmapJsonOutput(raw);
  }
  return parseSqlmapTextOutput(raw);
}
