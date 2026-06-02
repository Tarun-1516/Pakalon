/**
 * /autorun-issue — open a GitHub issue from the current failure log.
 *
 * The auditor / Phase 4 / Phase 5 agent calls this when it hits a
 * non-recoverable error and the user wants to file an upstream bug.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import logger from "@/utils/logger.js";

const execFileAsync = promisify(execFile);

export interface AutoRunIssueOptions {
  projectDir: string;
  title: string;
  body: string;
  /** Label list, e.g. ["bug", "agent-loop"]. Default ["auto-generated"] */
  labels?: string[];
  /** Open as a draft. */
  draft?: boolean;
}

export interface AutoRunIssueResult {
  number?: number;
  url?: string;
  reason?: string;
}

export async function openAutoRunIssue(opts: AutoRunIssueOptions): Promise<AutoRunIssueResult> {
  const labels = opts.labels ?? ["auto-generated"];
  const draftFlag = opts.draft ? "--draft" : "";
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "create", "--title", opts.title, "--body", opts.body, "--label", labels.join(","), draftFlag].filter(Boolean),
      { cwd: opts.projectDir },
    );
    const url = stdout.trim().split(/\r?\n/).pop();
    const m = url?.match(/\/issues\/(\d+)/);
    return { url, number: m ? Number(m[1]) : undefined };
  } catch (err) {
    logger.warn({ err }, "gh issue create failed");
    return { reason: (err as Error).message };
  }
}
