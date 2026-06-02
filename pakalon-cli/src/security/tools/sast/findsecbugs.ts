/**
 * FindSecBugs SAST tool runner (Java bytecode security scanner).
 *
 * Docker image: find-sec-bugs/find-sec-bugs:latest
 * Native fallback: `findsecbugs` if installed locally.
 *
 * Expects the project to have compiled .class files or .jar files.
 * The tool scans JAR/class files and outputs XML which is parsed here.
 */

import logger from '@/utils/logger.js';
import { type NormalizedFinding, type Severity, type SastToolOptions } from './types.js';
import { runInDocker, execCommand, isDockerAvailable } from './runner.js';

const IMAGE = 'find-sec-bugs/find-sec-bugs:latest';

function mapSeverity(raw?: string): Severity {
  const value = (raw ?? '').toUpperCase();
  if (value.includes('CRIT') || value.includes('HIGH')) return 'HIGH';
  if (value.includes('MED') || value.includes('MEDIUM')) return 'MEDIUM';
  if (value.includes('LOW') || value.includes('INFO')) return 'LOW';
  return 'MEDIUM';
}

interface FindSecBugsBug {
  category?: string;
  type?: string;
  method?: string;
  lineNumber?: number;
 LongMessage?: string;
  shortMessage?: string;
  priority?: string;
}

interface FindSecBugsCollection {
  BugCollection?: {
    Project?: { productName?: string };
    BugInstance?: FindSecBugsBug[];
  };
}

function parseFindSecBugsJson(raw: string): NormalizedFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  const collection = data as FindSecBugsCollection;
  const bugs = collection.BugCollection?.BugInstance ?? [];
  const findings: NormalizedFinding[] = [];

  for (const bug of bugs) {
    findings.push({
      tool: 'findsecbugs',
      ruleId: bug.type ?? 'findsecbugs-unknown',
      severity: mapSeverity(bug.priority),
      file: bug.method ?? 'unknown',
      line: bug.lineNumber,
      message: bug.LongMessage ?? bug.shortMessage ?? 'FindSecBugs finding',
    });
  }

  return findings;
}

/**
 * Run FindSecBugs against a project path.
 */
export async function runFindsecbugs(
  targetPath: string,
  opts: SastToolOptions & { outputFile?: string } = {},
): Promise<NormalizedFinding[]> {
  const timeout = opts.timeout ?? 180_000;
  const outputFile = opts.outputFile ?? '/output/findsecbugs-report.json';

  // Try Docker first
  if (await isDockerAvailable()) {
    const dockerCmd = [
      'findsecbugs',
      '-exitCodeRedirect',
      '-progress',
      `-jsonReportPath ${outputFile}`,
      '/src',
    ].join(' ');

    const result = await runInDocker({
      image: opts.imageOverride ?? IMAGE,
      targetPath,
      command: dockerCmd,
      extraArgs: [`-v "${targetPath}:/output"`],
      timeoutMs: timeout,
    });

    // Try reading the JSON report
    const stdout = result.stdout.trim();
    if (stdout) {
      const findings = parseFindSecBugsJson(stdout);
      if (findings.length > 0) return findings;
    }
  }

  // Native fallback
  logger.warn('[findsecbugs] Attempting native fallback');
  try {
    const nativeCmd = `findsecbugs -progress -exitCodeRedirect "${targetPath}"`;
    const result = await execCommand(nativeCmd, timeout);

    const stdout = result.stdout.trim();
    if (stdout) {
      return parseFindSecBugsJson(stdout);
    }
  } catch (err) {
    logger.warn(`[findsecbugs] Native fallback failed: ${err}`);
  }

  logger.warn('[findsecbugs] No findings (tool may not be installed or no Java bytecode found)');
  return [];
}
