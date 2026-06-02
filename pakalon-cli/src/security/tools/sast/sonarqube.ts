/**
 * SonarQube SAST tool runner.
 *
 * Uses sonarsource/sonar-scanner-cli:latest against a running SonarQube server.
 * The server (sonarqube:community) must be pre-provisioned or accessible at
 * the configured host URL.
 *
 * Native fallback: `sonar-scanner` if installed locally.
 */

import logger from '@/utils/logger.js';
import { type NormalizedFinding, type Severity, type SastToolOptions } from './types.js';
import { runInDocker, execCommand, isDockerAvailable } from './runner.js';

const SCANNER_IMAGE = 'sonarsource/sonar-scanner-cli:latest';
const DEFAULT_HOST_URL = 'http://host.docker.internal:9000';

function mapSeverity(raw?: string): Severity {
  const value = (raw ?? '').toUpperCase();
  if (value.includes('BLOCKER') || value.includes('CRIT')) return 'CRITICAL';
  if (value.includes('MAJOR') || value.includes('HIGH') || value.includes('ERROR')) return 'HIGH';
  if (value.includes('MINOR') || value.includes('MEDIUM') || value.includes('WARN')) return 'MEDIUM';
  if (value.includes('INFO') || value.includes('LOW')) return 'LOW';
  return 'MEDIUM';
}

interface SonarIssue {
  key?: string;
  rule?: string;
  severity?: string;
  component?: string;
  line?: number;
  message?: string;
  impacts?: Array<{ softwareQuality?: string; severity?: string }>;
  cwe?: string[];
}

interface SonarResponse {
  issues?: SonarIssue[];
}

function parseSonarJson(raw: string): NormalizedFinding[] {
  let data: SonarResponse;
  try {
    data = JSON.parse(raw) as SonarResponse;
  } catch {
    return [];
  }

  const issues = data.issues ?? [];
  const findings: NormalizedFinding[] = [];

  for (const issue of issues) {
    const component = issue.component ?? 'unknown';
    const filePath = component.includes(':') ? component.split(':').pop() ?? component : component;

    let severity: Severity = 'MEDIUM';
    if (issue.impacts && issue.impacts.length > 0) {
      severity = mapSeverity(issue.impacts[0]?.severity);
    } else {
      severity = mapSeverity(issue.severity);
    }

    const cweArr = issue.cwe;
    const cwe = Array.isArray(cweArr) && cweArr.length > 0 ? cweArr[0] : undefined;

    findings.push({
      tool: 'sonarqube',
      ruleId: issue.rule ?? 'sonarqube-unknown',
      severity,
      file: filePath,
      line: issue.line,
      message: issue.message ?? 'SonarQube issue',
      cwe,
    });
  }

  return findings;
}

/**
 * Run SonarQube scanner against a project path.
 *
 * Requires a running SonarQube server at hostUrl.
 */
export async function runSonarQube(
  targetPath: string,
  opts: SastToolOptions & { hostUrl?: string; projectKey?: string } = {},
): Promise<NormalizedFinding[]> {
  const timeout = opts.timeout ?? 120_000;
  const hostUrl = opts.hostUrl ?? process.env.SONAR_HOST_URL ?? DEFAULT_HOST_URL;
  const projectKey = opts.projectKey ?? `pakalon-${Date.now()}`;

  const scannerArgs = [
    `-e SONAR_HOST_URL=${hostUrl}`,
    `-e SONAR_PROJECT_KEY=${projectKey}`,
  ];

  // Try Docker scanner
  if (await isDockerAvailable()) {
    const dockerCmd = [
      `sonar-scanner`,
      `-Dsonar.projectBaseDir=/src`,
      `-Dsonar.sources=.`,
      `-Dsonar.host.url=${hostUrl}`,
      `-Dsonar.projectKey=${projectKey}`,
    ].join(' ');

    const result = await runInDocker({
      image: opts.imageOverride ?? SCANNER_IMAGE,
      targetPath,
      command: dockerCmd,
      extraArgs: scannerArgs,
      timeoutMs: timeout,
    });

    // SonarQube scanner doesn't output JSON by default; read from server API.
    // Attempt to fetch issues from the SonarQube Web API.
    if (result.exitCode === 0 || result.stdout.includes('SUCCESS')) {
      const issues = await fetchSonarIssues(hostUrl, projectKey, timeout);
      if (issues.length > 0) return issues;
    }

    // Fall through if server not reachable
    const stdout = result.stdout.trim();
    if (stdout) {
      return parseSonarJson(stdout);
    }
  }

  // Native fallback
  logger.warn('[sonarqube] Attempting native fallback');
  try {
    const nativeCmd = [
      'sonar-scanner',
      `-Dsonar.projectBaseDir="${targetPath}"`,
      `-Dsonar.sources=.`,
      `-Dsonar.host.url=${hostUrl}`,
      `-Dsonar.projectKey=${projectKey}`,
    ].join(' ');

    const result = await execCommand(nativeCmd, timeout);
    if (result.exitCode === 0) {
      return await fetchSonarIssues(hostUrl, projectKey, timeout);
    }
  } catch (err) {
    logger.warn(`[sonarqube] Native fallback failed: ${err}`);
  }

  logger.warn('[sonarqube] No findings (SonarQube server may not be running)');
  return [];
}

/**
 * Fetch issues from SonarQube Web API after a scan.
 */
async function fetchSonarIssues(
  hostUrl: string,
  projectKey: string,
  timeoutMs: number,
): Promise<NormalizedFinding[]> {
  const apiUrl = `${hostUrl}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&ps=500&resolved=false`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];

    const data = (await response.json()) as SonarResponse;
    return parseSonarJson(JSON.stringify(data));
  } catch {
    return [];
  }
}
