/**
 * /theme — switch the TUI theme.
 */
import { askUserQuestion, type AskUserQuestion } from "@/tools/AskUserQuestionTool/AskUserQuestionTool.js";
import { setTheme, getSettings, type Settings } from "@/settings/cli-settings.js";
import logger from "@/utils/logger.js";

const Q: AskUserQuestion = {
  question: "Which theme do you want?",
  header: "Theme",
  multiSelect: false,
  options: [
    { label: "Auto (system)", description: "Follow the OS preference" },
    { label: "Light", description: "Always light" },
    { label: "Dark", description: "Always dark" },
  ],
};

export async function pickTheme(): Promise<NonNullable<Settings["theme"]>> {
  const [ans] = await askUserQuestion({ questions: [Q] });
  const lower = ans.answer.toLowerCase();
  const next: NonNullable<Settings["theme"]> = lower.startsWith("light") ? "light" : lower.startsWith("dark") ? "dark" : "auto";
  setTheme(next);
  logger.info({ theme: next }, "Theme set");
  return next;
}
