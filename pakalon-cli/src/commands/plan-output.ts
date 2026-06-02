/**
 * /plan — wrapper that writes the plan to a single `output.md` file
 * (per CLI-req §"Plan").
 *
 * When the user runs `/plan some prompt`, the agent produces a
 * structured plan and this command writes it to
 * `.pakalon-agents/output.md` for easy sharing.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { generateText } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import logger from "@/utils/logger.js";

export interface PlanOutputOptions {
  projectDir: string;
  prompt: string;
  /** Append to the existing file instead of overwriting. */
  append?: boolean;
}

export async function writePlanOutput(opts: PlanOutputOptions): Promise<string> {
  const dir = path.join(opts.projectDir, ".pakalon-agents", "ai-agents");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "output.md");

  let result: { text: string };
  try {
    result = await generateText({
      model: openrouter("anthropic/claude-3-5-sonnet"),
      prompt: `Create a structured implementation plan (in markdown) for the following request. Use sections: Goals, Non-goals, Architecture, Milestones, Risks.\n\nRequest: ${opts.prompt}`,
      maxTokens: 2048,
    });
  } catch (err) {
    logger.warn({ err }, "Plan LLM call failed; writing a stub");
    result = { text: `# Plan\n\n_${opts.prompt}_\n\n_(LLM unavailable — placeholder.)_` };
  }

  if (opts.append) {
    const prev = await fs.readFile(file, "utf-8").catch(() => "");
    await fs.writeFile(file, `${prev}\n\n---\n\n${result.text}\n`, "utf-8");
  } else {
    await fs.writeFile(file, result.text, "utf-8");
  }
  logger.info({ file }, "Plan output written");
  return file;
}
