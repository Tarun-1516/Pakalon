/**
 * /effort — set the model's effort level.
 *
 * Maps to OpenRouter's `reasoning.effort` knob. Higher effort = more
 * tokens spent on internal reasoning, more accurate output.
 */
import { askUserQuestion, type AskUserQuestion } from "@/tools/AskUserQuestionTool/AskUserQuestionTool.js";
import { setEffortLevel, getSettings, type Settings } from "@/settings/cli-settings.js";
import logger from "@/utils/logger.js";

const Q: AskUserQuestion = {
  question: "How much effort should the model apply?",
  header: "Effort",
  multiSelect: false,
  options: [
    { label: "Low", description: "Fast, fewer tokens, less accurate" },
    { label: "Medium", description: "Balanced" },
    { label: "High", description: "More reasoning, slower" },
    { label: "Max", description: "Maximum reasoning — for hard problems" },
  ],
};

export async function pickEffort(): Promise<NonNullable<Settings["effortLevel"]>> {
  const [ans] = await askUserQuestion({ questions: [Q] });
  const lower = ans.answer.toLowerCase() as NonNullable<Settings["effortLevel"]>;
  setEffortLevel(lower);
  logger.info({ effort: lower }, "Effort level set");
  return lower;
}

export function currentEffort(): NonNullable<Settings["effortLevel"]> {
  return getSettings().effortLevel ?? "medium";
}
