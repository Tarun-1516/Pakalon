/**
 * Sandbox -> Production auto-promotion.
 *
 * Wraps the existing PolicyEvaluator + SandboxDeployer and adds an
 * "auto-promote" path that the Phase 5 deploy agent can call when
 * the user opts in (`--promote-on-pass`).
 *
 * Flow:
 *   1. Run all sandbox tests.
 *   2. Evaluate the policy.
 *   3. If green and `autoPromote === true`, run the deployment.
 *   4. Return a single report object.
 */
import { PolicyEvaluator, SandboxTester, type DeployOptions, type DeployResult, type TestResults } from "@/sandbox/index.js";
import logger from "@/utils/logger.js";

export interface PromoteOptions extends DeployOptions {
  /** Run tests + deploy in one shot */
  autoPromote?: boolean;
  /** Skip the test step (deploy only). */
  skipTests?: boolean;
}

export interface PromoteReport {
  tested: boolean;
  tests: TestResults | null;
  policyPassed: boolean;
  deployed: boolean;
  deployResult: DeployResult | null;
  durationMs: number;
}

export async function promoteSandboxToProduction(opts: PromoteOptions): Promise<PromoteReport> {
  const start = Date.now();
  const tester = new SandboxTester();
  const evaluator = new PolicyEvaluator();

  let tests: TestResults | null = null;
  if (!opts.skipTests) {
    try {
      tests = await tester.run({
        projectDir: opts.projectDir,
        sandboxUrl: opts.sandboxUrl ?? "http://localhost:9000",
        ...(opts.sandboxId ? { sandboxId: opts.sandboxId } : {}),
      });
    } catch (err) {
      logger.warn({ err }, "Sandbox tests failed to run; cannot promote");
    }
  }

  const policy = evaluator.evaluate({ tests, allowOverride: false });
  if (!policy.passed) {
    return {
      tested: !opts.skipTests,
      tests,
      policyPassed: false,
      deployed: false,
      deployResult: null,
      durationMs: Date.now() - start,
    };
  }

  if (!opts.autoPromote) {
    return {
      tested: !opts.skipTests,
      tests,
      policyPassed: true,
      deployed: false,
      deployResult: null,
      durationMs: Date.now() - start,
    };
  }

  // Hand off to the actual deploy module
  const { deployToCloud } = await import("@/deployment/wizard.js");
  const result = await deployToCloud(opts.projectDir, {
    provider: (opts.provider as any) ?? "aws",
    region: opts.region ?? "us-east-1",
    credentials: opts.credentials ?? {},
    skipped: false,
  });
  return {
    tested: !opts.skipTests,
    tests,
    policyPassed: true,
    deployed: true,
    deployResult: { ok: true, url: opts.sandboxUrl ?? "http://localhost:9000", message: result } as any,
    durationMs: Date.now() - start,
  };
}
