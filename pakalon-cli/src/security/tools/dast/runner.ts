import type { NormalizedDastFinding, DastToolOptions, DastToolName } from './types.js';
import { runOwaspZap } from './owasp-zap.js';
import { runNikto } from './nikto.js';
import { runSqlmap } from './sqlmap.js';
import { runWapiti } from './wapiti.js';
import { runXsstrike } from './xsstrike.js';

const TOOL_REGISTRY: Record<DastToolName, (targetUrl: string, opts: DastToolOptions) => Promise<NormalizedDastFinding[]>> = {
  'owasp-zap': runOwaspZap,
  nikto: runNikto,
  sqlmap: runSqlmap,
  wapiti: runWapiti,
  xsstrike: runXsstrike,
};

export const ALL_DAST_TOOLS: DastToolName[] = ['owasp-zap', 'nikto', 'sqlmap', 'wapiti', 'xsstrike'];

/**
 * Run a single DAST tool by name against the target URL.
 * Returns NormalizedDastFinding[] (empty array if tool fails).
 */
export async function runDastTool(
  tool: DastToolName,
  targetUrl: string,
  opts: DastToolOptions = {},
): Promise<NormalizedDastFinding[]> {
  const runner = TOOL_REGISTRY[tool];
  if (!runner) {
    console.warn(`[dast] Unknown tool: ${tool}`);
    return [];
  }
  try {
    return await runner(targetUrl, opts);
  } catch (err) {
    console.warn(`[dast] Tool ${tool} failed: ${err}`);
    return [];
  }
}

/**
 * Run all 5 DAST tools and aggregate findings.
 * Continues even if individual tools fail.
 */
export async function runAllDastTools(
  targetUrl: string,
  opts: DastToolOptions = {},
): Promise<NormalizedDastFinding[]> {
  const allFindings: NormalizedDastFinding[] = [];

  for (const tool of ALL_DAST_TOOLS) {
    console.info(`[dast] Running ${tool}...`);
    const findings = await runDastTool(tool, targetUrl, opts);
    console.info(`[dast] ${tool}: ${findings.length} finding(s)`);
    allFindings.push(...findings);
  }

  return allFindings;
}
