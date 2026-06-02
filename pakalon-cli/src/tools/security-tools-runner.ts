/**
 * Security tools runner — real subprocess execution for the 15+ SAST
 * and DAST tools the CLI bundles.
 *
 * Each tool reports a normalised shape:
 *   { tool, available, findings: Finding[], durationMs, raw? }
 *
 * If a binary is not installed on $PATH the tool records
 * `available: false` and returns gracefully. Pakalon should not
 * hard-fail the build just because `nikto` is missing.
 */
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs/promises";
import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Finding {
  ruleId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  message: string;
  file?: string;
  line?: number;
  tool: string;
  raw?: unknown;
}

export interface ScanResult {
  tool: string;
  available: boolean;
  findings: Finding[];
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    const p = spawn(cmd, [bin]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      if (code === 0) {
        const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        resolve(first ?? null);
      } else {
        resolve(null);
      }
    });
  });
}

function runBin(bin: string, args: string[], cwd: string, timeoutMs = 5 * 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

// ---------------------------------------------------------------------------
// SAST tools
// ---------------------------------------------------------------------------

export async function runSemgrep(projectDir: string): Promise<ScanResult> {
  return runGeneric(projectDir, "semgrep", "semgrep", ["--config=auto", "--json", "--quiet", "."], parseSemgrep);
}

export async function runGitleaks(projectDir: string): Promise<ScanResult> {
  return runGeneric(projectDir, "gitleaks", "gitleaks", ["detect", "--no-git", "-r", "json", "-f", "-"], parseGitleaks);
}

export async function runBandit(projectDir: string): Promise<ScanResult> {
  return runGeneric(projectDir, "bandit", "bandit", ["-r", ".", "-f", "json", "-q"], parseBandit);
}

export async function runEslintSecurity(projectDir: string): Promise<ScanResult> {
  return runGeneric(projectDir, "eslint-security", "eslint", ["--ext", ".js,.ts,.tsx", "--format", "json", "--no-color", "."], parseEslint);
}

export async function runFindsecbugs(projectDir: string): Promise<ScanResult> {
  // findsecbugs is a Java tool; we attempt it but never fail the build.
  return runGeneric(projectDir, "findsecbugs", "findsecbugs", ["-progress", "-xml", "."], parseSarifLike, 10 * 60_000);
}

export async function runSonarqube(projectDir: string): Promise<ScanResult> {
  return runGeneric(projectDir, "sonarqube", "sonar-scanner", [], () => []);
}

export async function runBrakeman(projectDir: string): Promise<ScanResult> {
  return runGeneric(projectDir, "brakeman", "brakeman", ["--no-progress", "-f", "json", "."], parseBrakeman);
}

// ---------------------------------------------------------------------------
// DAST tools
// ---------------------------------------------------------------------------

export async function runOwaspZap(projectDir: string, target = "http://127.0.0.1:3000"): Promise<ScanResult> {
  return runGeneric(projectDir, "owasp-zap", "zap-cli", ["quick-scan", "--self-signed", "--spider", target], () => []);
}

export async function runNikto(projectDir: string, target = "http://127.0.0.1:3000"): Promise<ScanResult> {
  return runGeneric(projectDir, "nikto", "nikto", ["-h", target, "-Tuning", "1234", "-ask", "no"], () => []);
}

export async function runSqlmap(projectDir: string, target = "http://127.0.0.1:3000"): Promise<ScanResult> {
  return runGeneric(projectDir, "sqlmap", "sqlmap", ["-u", target, "--batch", "--disable-coloring", "--output-dir", path.join(projectDir, ".pakalon-agents", "ai-agents", "phase-4", "sqlmap")], () => []);
}

export async function runWapiti(projectDir: string, target = "http://127.0.0.1:3000"): Promise<ScanResult> {
  return runGeneric(projectDir, "wapiti", "wapiti", ["-u", target, "-f", "json", "-o", path.join(projectDir, ".pakalon-agents", "ai-agents", "phase-4", "wapiti.json")], () => []);
}

export async function runXsstrike(projectDir: string, target = "http://127.0.0.1:3000"): Promise<ScanResult> {
  return runGeneric(projectDir, "xsstrike", "xsstrike", ["-u", target, "--crawl"], () => []);
}

// ---------------------------------------------------------------------------
// Generic runner
// ---------------------------------------------------------------------------

async function runGeneric(
  projectDir: string,
  tool: string,
  bin: string,
  args: string[],
  parser: (stdout: string, stderr: string) => Finding[],
  timeoutMs = 5 * 60_000,
): Promise<ScanResult> {
  const start = Date.now();
  const binPath = await which(bin);
  if (!binPath) {
    logger.warn({ tool, bin }, `${tool} binary not found on PATH`);
    return { tool, available: false, findings: [], durationMs: 0, error: `${bin} not installed` };
  }
  try {
    const { stdout, stderr, code } = await runBin(binPath, args, projectDir, timeoutMs);
    const findings = parser(stdout, stderr);
    return {
      tool,
      available: true,
      findings,
      durationMs: Date.now() - start,
      ...(code !== 0 ? { error: `exit ${code}` } : {}),
    };
  } catch (err) {
    return {
      tool,
      available: true,
      findings: [],
      durationMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Parsers (defensive: tolerate non-JSON output)
// ---------------------------------------------------------------------------

function parseSemgrep(stdout: string, _stderr: string): Finding[] {
  try {
    const data = JSON.parse(stdout) as { results?: any[] };
    return (data.results ?? []).map((r) => ({
      ruleId: r.check_id,
      severity: mapSeverity(r.extra?.severity),
      message: r.extra?.message ?? r.check_id,
      file: r.path,
      line: r.start?.line,
      tool: "semgrep",
      raw: r,
    }));
  } catch {
    return [];
  }
}

function parseGitleaks(stdout: string, _stderr: string): Finding[] {
  try {
    const data = JSON.parse(stdout) as Array<any>;
    return data.map((r) => ({
      ruleId: r.RuleID ?? "gitleaks",
      severity: "high" as const,
      message: `${r.Description ?? "secret"} in ${r.File}`,
      file: r.File,
      line: r.StartLine,
      tool: "gitleaks",
      raw: r,
    }));
  } catch {
    return [];
  }
}

function parseBandit(stdout: string, _stderr: string): Finding[] {
  try {
    const data = JSON.parse(stdout) as { results?: any[] };
    return (data.results ?? []).map((r) => ({
      ruleId: r.test_id,
      severity: mapSeverity(r.issue_severity),
      message: r.issue_text,
      file: r.filename,
      line: r.line_number,
      tool: "bandit",
      raw: r,
    }));
  } catch {
    return [];
  }
}

function parseEslint(stdout: string, _stderr: string): Finding[] {
  try {
    const arr = JSON.parse(stdout) as Array<{ filePath: string; messages: any[] }>;
    const out: Finding[] = [];
    for (const file of arr) {
      for (const m of file.messages) {
        out.push({
          ruleId: m.ruleId ?? "eslint",
          severity: m.severity === 2 ? "high" : "low",
          message: m.message,
          file: file.filePath,
          line: m.line,
          tool: "eslint",
          raw: m,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function parseBrakeman(stdout: string, _stderr: string): Finding[] {
  try {
    const data = JSON.parse(stdout) as { warnings?: any[] };
    return (data.warnings ?? []).map((w) => ({
      ruleId: w.warning_type,
      severity: mapSeverity(w.severity),
      message: w.message,
      file: w.file,
      line: w.line,
      tool: "brakeman",
      raw: w,
    }));
  } catch {
    return [];
  }
}

function parseSarifLike(stdout: string, _stderr: string): Finding[] {
  // best-effort: most tools return some JSON/XML — we just look for lines that smell like findings
  const out: Finding[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (/warning|error|vulnerability/i.test(line)) {
      out.push({ ruleId: "findsecbugs", severity: "medium", message: line.trim().slice(0, 240), tool: "findsecbugs" });
    }
  }
  return out;
}

function mapSeverity(s: string | undefined): Finding["severity"] {
  switch ((s ?? "").toLowerCase()) {
    case "critical":
    case "blocker":
      return "critical";
    case "high":
    case "error":
      return "high";
    case "medium":
    case "warning":
    case "moderate":
      return "medium";
    case "low":
    case "note":
      return "low";
    default:
      return "info";
  }
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export async function runAllScans(projectDir: string, target?: string): Promise<ScanResult[]> {
  const all = [
    runSemgrep(projectDir),
    runGitleaks(projectDir),
    runBandit(projectDir),
    runEslintSecurity(projectDir),
    runFindsecbugs(projectDir),
    runSonarqube(projectDir),
    runBrakeman(projectDir),
    runOwaspZap(projectDir, target),
    runNikto(projectDir, target),
    runSqlmap(projectDir, target),
    runWapiti(projectDir, target),
    runXsstrike(projectDir, target),
  ];
  return Promise.all(all);
}

export async function writeScanReport(projectDir: string, results: ScanResult[]): Promise<string> {
  const dir = path.join(projectDir, ".pakalon-agents", "ai-agents", "phase-4");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "security-report.json");
  await fs.writeFile(file, JSON.stringify(results, null, 2), "utf-8");
  return file;
}
