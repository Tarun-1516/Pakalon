/**
 * Normalized SAST finding produced by all SAST tool runners.
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface NormalizedFinding {
  tool: string;
  ruleId: string;
  severity: Severity;
  file: string;
  line?: number;
  column?: number;
  message: string;
  cwe?: string;
  cve?: string;
  fixSuggestion?: string;
}

export type SastToolName = 'semgrep' | 'sonarqube' | 'gitleaks' | 'bandit' | 'findsecbugs';

export interface SastToolOptions {
  /** Extra arguments passed to the tool's Docker run invocation. */
  extraArgs?: string[];
  /** Custom Docker image override (e.g. for air-gapped registries). */
  imageOverride?: string;
  /** Timeout in milliseconds (default 120 000). */
  timeout?: number;
  /** Working directory for Docker context. Defaults to targetPath. */
  cwd?: string;
}
