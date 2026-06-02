/**
 * /output-style — pick the default output verbosity.
 *
 * Mirrors the reference CLI's `OutputStyle` system. Options:
 *   - default
 *   - explanatory
 *   - concise
 *   - verbose
 */
import { askUserQuestion, type AskUserQuestion } from "@/tools/AskUserQuestionTool/AskUserQuestionTool.js";
import { setOutputStyle, getSettings, type Settings } from "@/settings/cli-settings.js";
import logger from "@/utils/logger.js";

const Q: AskUserQuestion = {
  question: "Which output style should Pakalon use?",
  header: "Output",
  multiSelect: false,
  options: [
    { label: "Default", description: "Balanced prose and tool output" },
    { label: "Explanatory", description: "Show reasoning + plan before each step" },
    { label: "Concise", description: "Minimal prose, only essential info" },
    { label: "Verbose", description: "Full reasoning + all tool args" },
  ],
};

export async function pickOutputStyle(): Promise<NonNullable<Settings["outputStyle"]>> {
  const [ans] = await askUserQuestion({ questions: [Q] });
  const next = ans.answer.toLowerCase() as NonNullable<Settings["outputStyle"]>;
  setOutputStyle(next);
  logger.info({ style: next }, "Output style set");
  return next;
}

export function currentOutputStyle(): NonNullable<Settings["outputStyle"]> {
  return getSettings().outputStyle ?? "default";
}
