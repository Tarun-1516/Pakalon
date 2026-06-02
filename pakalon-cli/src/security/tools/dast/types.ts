/**
 * Normalized DAST finding type shared by all 5 DAST tool wrappers.
 */

export type DastSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface NormalizedDastFinding {
  tool: string;
  alertId: string;
  severity: DastSeverity;
  url: string;
  method?: string;
  parameter?: string;
  payload?: string;
  evidence?: string;
  description: string;
  cwe?: string;
  cve?: string;
  fixSuggestion?: string;
}

export interface DastToolOptions {
  timeout?: number;
  outputDir?: string;
  extraArgs?: string[];
  networkArgs?: string;
  env?: Record<string, string>;
}

export type DastToolName = 'owasp-zap' | 'nikto' | 'sqlmap' | 'wapiti' | 'xsstrike';
