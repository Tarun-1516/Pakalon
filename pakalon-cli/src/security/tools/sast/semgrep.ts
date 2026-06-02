/**
 * Semgrep SAST tool runner.
 *
 * Docker image: returntocorp/semgrep:latest
 * Native fallback: `semgrep scan --config auto --json`
 */

import logger from '@/utils/logger.js';
import { type NormalizedFinding, type Severity, type SastToolOptions } from './types.js';
import { runInDocker, execCommand, isDockerAvailable } from './runner.js';

const IMAGE = 'returntocorp/semgrep:latest';

function mapSeverity(raw?: string): Severity {
  const value = (raw ?? '').toUpperCase();
  if (value === 'ERROR') return 'HIGH';
  if (value === 'WARNING') return 'MEDIUM';
  if (value === 'INFO') return 'LOW';
  if (value.includes('CRIT')) return 'CRITICAL';
  return 'MEDIUM';
}

interface SemgrepResult {
  results?: Array<{
    check_id?: string;
    path?: string;
    start?: { line?: number; col?: number };
    extra?: {
      severity?: string;
      message?: string;
      metadata?: {
        cwe?: string[];
        owasp?: string[];
        fix?: string;
      };
    };
  }>;
}

function parseSemgrepJson(raw: string): NormalizedFinding[] {
  let data: SemgrepResult;
  try {
    data = JSON.parse(raw) as SemgrepResult;
  } catch {
    return [];
  }

  const results = data.results ?? [];
  const findings: NormalizedFinding[] = [];

  for (const r of results) {
    const metadata = r.extra?.metadata;
    const cweArr = metadata?.cwe;
    const cwe = Array.isArray(cweArr) && cweArr.length > 0
      ? cweArr[0] ?? undefined
      : undefined;

    findings.push({
      tool: 'semgrep',
      ruleId: r.check_id ?? 'semgrep-unknown',
      severity: mapSeverity(r.extra?.severity),
      file: r.path ?? 'unknown',
      line: r.start?.line,
      column: r.start?.col,
      message: r.extra?.message ?? 'Semgrep finding',
      cwe,
      fixSuggestion: metadata?.fix,
    });
  }

  return findings;
}

/**
 * Run Semgrep against a project path, returning normalized findings.
 */
export async function runSemgrep(
  targetPath: string,
  opts: SastToolOptions = {},
): Promise<NormalizedFinding[]> {
  const timeout = opts.timeout ?? 120_000;

  // Try Docker first
  if (await isDockerAvailable()) {
    const dockerCmd = [
      'semgrep',
      'scan',
      '--config',
      'auto',
      '--json',
      '--quiet',
      '/src',
    ].join(' ');

    const result = await runInDocker({
      image: opts.imageOverride ?? IMAGE,
      targetPath,
      command: dockerCmd,
      timeoutMs: timeout,
    });

    const stdout = result.stdout.trim();
    if (stdout) {
      const findings = parseSemgrepJson(stdout);
      if (findings.length > 0) return findings;
    }
  }

  // Native fallback
  logger.warn('[semgrep] Attempting native fallback (Docker unavailable)');
  try {
    const nativeCmd = `semgrep scan --config auto --json --quiet "${targetPath}"`;
    const result = await execCommand(nativeCmd, timeout);
    const stdout = result.stdout.trim();
    if (stdout) {
      return parseSemgrepJson(stdout);
    }
  } catch (err) {
    logger.warn(`[semgrep] Native fallback failed: ${err}`);
  }

  logger.warn('[semgrep] No findings (tool may not be installed)');
  return [];
}
