/**
 * SAST Tool Dispatcher
 *
 * Provides a unified `runSastTool` function that dispatches to the correct
 * tool runner by name, and a `runAllSastTools` convenience function that
 * runs all five tools and aggregates results.
 */

import logger from '@/utils/logger.js';
import type { NormalizedFinding, SastToolName, SastToolOptions } from './types.js';
import { runSemgrep } from './semgrep.js';
import { runSonarQube } from './sonarqube.js';
import { runGitleaks } from './gitleaks.js';
import { runBandit } from './bandit.js';
import { runFindsecbugs } from './findsecbugs.js';

export type { NormalizedFinding, SastToolName, SastToolOptions } from './types.js';
export { runSemgrep } from './semgrep.js';
export { runSonarQube } from './sonarqube.js';
export { runGitleaks } from './gitleaks.js';
export { runBandit } from './bandit.js';
export { runFindsecbugs } from './findsecbugs.js';

const TOOL_RUNNERS: Record<
  SastToolName,
  (targetPath: string, opts: SastToolOptions) => Promise<NormalizedFinding[]>
> = {
  semgrep: runSemgrep,
  sonarqube: runSonarQube,
  gitleaks: runGitleaks,
  bandit: runBandit,
  findsecbugs: runFindsecbugs,
};

/**
 * Run a single named SAST tool against a project path.
 *
 * If the tool fails, logs a warning and returns an empty array so the caller
 * can continue with other tools.
 */
export async function runSastTool(
  tool: SastToolName,
  targetPath: string,
  opts: SastToolOptions = {},
): Promise<NormalizedFinding[]> {
  const runner = TOOL_RUNNERS[tool];
  if (!runner) {
    logger.warn(`[sast-dispatcher] Unknown SAST tool: ${tool}`);
    return [];
  }

  try {
    logger.info(`[sast-dispatcher] Running ${tool}...`);
    const findings = await runner(targetPath, opts);
    logger.info(`[sast-dispatcher] ${tool} completed: ${findings.length} finding(s)`);
    return findings;
  } catch (err) {
    logger.warn(`[sast-dispatcher] ${tool} failed: ${err}`);
    return [];
  }
}

/**
 * Run all five SAST tools and return aggregated findings.
 * Failures in individual tools do not prevent other tools from running.
 */
export async function runAllSastTools(
  targetPath: string,
  opts: SastToolOptions = {},
): Promise<NormalizedFinding[]> {
  const tools: SastToolName[] = ['semgrep', 'sonarqube', 'gitleaks', 'bandit', 'findsecbugs'];
  const allFindings: NormalizedFinding[] = [];

  for (const tool of tools) {
    const findings = await runSastTool(tool, targetPath, opts);
    allFindings.push(...findings);
  }

  logger.info(`[sast-dispatcher] All SAST tools completed: ${allFindings.length} total finding(s)`);
  return allFindings;
}
