/**
 * /pr-comments — post a comment to a GitHub PR.
 *
 * The Phase 5 deploy agent and the auditor use this to attach
 * compliance findings to the PR.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import logger from "@/utils/logger.js";

const execFileAsync = promisify(execFile);

export interface PrCommentOptions {
  projectDir: string;
  /** PR number */
  pr: number;
  body: string;
}

export interface PrCommentResult {
  ok: boolean;
  url?: string;
  reason?: string;
}

export async function postPrComment(opts: PrCommentOptions): Promise<PrCommentResult> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "comment", String(opts.pr), "--body", opts.body], { cwd: opts.projectDir });
    return { ok: true, url: stdout.trim().split(/\r?\n/).pop() };
  } catch (err) {
    logger.warn({ err }, "gh pr comment failed");
    return { ok: false, reason: (err as Error).message };
  }
}
