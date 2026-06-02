/**
 * Gitleaks SAST tool runner (secret detection).
 *
 * Docker image: zricethezav/gitleaks:latest
 * Native fallback: `gitleaks detect`
 */

import logger from '@/utils/logger.js';
import { type NormalizedFinding, type SastToolOptions } from './types.js';
import { runInDocker, execCommand, isDockerAvailable } from './runner.js';

const IMAGE = 'zricethezav/gitleaks:latest';

interface GitleaksEntry {
  RuleID?: string;
  File?: string;
  StartLine?: number;
  EndLine?: number;
  StartColumn?: number;
  EndColumn?: number;
  Description?: string;
  Secret?: string;
  Severity?: string;
  Match?: string;
}

function parseGitleaksJson(raw: string): NormalizedFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  const entries: GitleaksEntry[] = Array.isArray(data) ? data : [];
  const findings: NormalizedFinding[] = [];

  for (const entry of entries) {
    findings.push({
      tool: 'gitleaks',
      ruleId: entry.RuleID ?? 'gitleaks-unknown',
      severity: 'CRITICAL',
      file: entry.File ?? 'unknown',
      line: entry.StartLine,
      column: entry.StartColumn,
      message: entry.Description ?? `Secret detected: ${entry.RuleID ?? 'unknown rule'}`,
      cve: entry.RuleID,
      fixSuggestion: 'Rotate the exposed secret and remove it from version control history.',
    });
  }

  return findings;
}

/**
 * Run Gitleaks against a project path to detect secrets.
 */
export async function runGitleaks(
  targetPath: string,
  opts: SastToolOptions = {},
): Promise<NormalizedFinding[]> {
  const timeout = opts.timeout ?? 120_000;

  // Try Docker first
  if (await isDockerAvailable()) {
    const dockerCmd = [
      'gitleaks',
      'detect',
      '--source=/src',
      '--report-format=json',
      '--report-path=/dev/stdout',
      '--no-git',
    ].join(' ');

    const result = await runInDocker({
      image: opts.imageOverride ?? IMAGE,
      targetPath,
      command: dockerCmd,
      timeoutMs: timeout,
    });

    // gitleaks exits 1 when secrets found, 2 on error
    const stdout = result.stdout.trim();
    if (stdout) {
      const findings = parseGitleaksJson(stdout);
      if (findings.length > 0) return findings;
    }

    if (result.exitCode === 0 && !stdout) {
      return [];
    }
  }

  // Native fallback
  logger.warn('[gitleaks] Attempting native fallback');
  try {
    const nativeCmd = `gitleaks detect --source "${targetPath}" --report-format json --no-git`;
    const result = await execCommand(nativeCmd, timeout);

    const stdout = result.stdout.trim();
    if (stdout) {
      return parseGitleaksJson(stdout);
    }

    if (result.exitCode === 0) {
      return [];
    }
  } catch (err) {
    logger.warn(`[gitleaks] Native fallback failed: ${err}`);
  }

  logger.warn('[gitleaks] No findings (tool may not be installed)');
  return [];
}
