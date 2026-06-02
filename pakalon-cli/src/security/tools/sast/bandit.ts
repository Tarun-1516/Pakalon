/**
 * Bandit SAST tool runner (Python security linter).
 *
 * Docker image: python:3.11-slim (installs bandit, then runs)
 * Native fallback: `bandit` if installed locally.
 */

import logger from '@/utils/logger.js';
import { type NormalizedFinding, type Severity, type SastToolOptions } from './types.js';
import { runInDocker, execCommand, isDockerAvailable } from './runner.js';

const IMAGE = 'python:3.11-slim';

function mapSeverity(raw?: string): Severity {
  const value = (raw ?? '').toUpperCase();
  if (value === 'HIGH' || value === 'ERROR') return 'HIGH';
  if (value === 'MEDIUM' || value === 'MEDIUM+' || value === 'WARNING') return 'MEDIUM';
  if (value === 'LOW' || value === 'UNDEFINED') return 'LOW';
  return 'MEDIUM';
}

interface BanditIssue {
  code?: string;
  filename?: string;
  line_number?: number;
  issue_text?: string;
  issue_severity?: string;
  issue_confidence?: string;
  issue_cwe?: { id?: number; link?: string };
  more_info?: string;
}

interface BanditReport {
  results?: BanditIssue[];
}

function parseBanditJson(raw: string): NormalizedFinding[] {
  let data: BanditReport;
  try {
    data = JSON.parse(raw) as BanditReport;
  } catch {
    return [];
  }

  const issues = data.results ?? [];
  const findings: NormalizedFinding[] = [];

  for (const issue of issues) {
    const cweId = issue.issue_cwe?.id;
    findings.push({
      tool: 'bandit',
      ruleId: issue.code ?? 'bandit-unknown',
      severity: mapSeverity(issue.issue_severity),
      file: issue.filename ?? 'unknown',
      line: issue.line_number,
      message: issue.issue_text ?? 'Bandit finding',
      cwe: cweId ? `CWE-${cweId}` : undefined,
      fixSuggestion: issue.more_info,
    });
  }

  return findings;
}

/**
 * Run Bandit against a project path.
 */
export async function runBandit(
  targetPath: string,
  opts: SastToolOptions = {},
): Promise<NormalizedFinding[]> {
  const timeout = opts.timeout ?? 120_000;

  // Try Docker first
  if (await isDockerAvailable()) {
    const dockerCmd = [
      'sh',
      '-c',
      '"pip install --quiet bandit && bandit -r /src -f json --exit-zero"',
    ].join(' ');

    const result = await runInDocker({
      image: opts.imageOverride ?? IMAGE,
      targetPath,
      command: dockerCmd,
      timeoutMs: timeout,
    });

    const stdout = result.stdout.trim();
    if (stdout) {
      return parseBanditJson(stdout);
    }
  }

  // Native fallback
  logger.warn('[bandit] Attempting native fallback');
  try {
    const nativeCmd = `bandit -r "${targetPath}" -f json --exit-zero`;
    const result = await execCommand(nativeCmd, timeout);

    const stdout = result.stdout.trim();
    if (stdout) {
      return parseBanditJson(stdout);
    }
  } catch (err) {
    logger.warn(`[bandit] Native fallback failed: ${err}`);
  }

  logger.warn('[bandit] No findings (tool may not be installed)');
  return [];
}
