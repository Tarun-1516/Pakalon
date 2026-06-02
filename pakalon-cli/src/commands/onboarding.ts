/**
 * /onboarding — first-run wizard for the CLI.
 *
 * Walks the user through:
 *   1. Login / signup
 *   2. Default model selection
 *   3. Theme / output style / privacy
 *   4. Optional integrations (GitHub, Slack, Telegram)
 */
import { askUserQuestion, type AskUserQuestion } from "@/tools/AskUserQuestionTool/AskUserQuestionTool.js";
import { setTheme, setOutputStyle, setPrivacyMode } from "@/settings/cli-settings.js";
import { installGithubApp } from "@/commands/install-github-app.js";
import { installSlackApp } from "@/commands/install-slack-app.js";
import { connectTelegram } from "@/commands/connect.js";
import logger from "@/utils/logger.js";

const Q_LOGIN: AskUserQuestion = {
  question: "Do you already have a Pakalon account?",
  header: "Login",
  multiSelect: false,
  options: [
    { label: "Yes, log me in", description: "Use the device-code flow" },
    { label: "No, create one", description: "Open the signup page" },
    { label: "Skip — self-hosted", description: "No auth required" },
  ],
};

const Q_THEME: AskUserQuestion = {
  question: "Pick a theme:",
  header: "Theme",
  multiSelect: false,
  options: [
    { label: "Auto (system)", description: "Follow OS preference" },
    { label: "Light", description: "Always light" },
    { label: "Dark", description: "Always dark" },
  ],
};

const Q_OUTPUT: AskUserQuestion = {
  question: "Default output style:",
  header: "Output",
  multiSelect: false,
  options: [
    { label: "Default", description: "Balanced" },
    { label: "Explanatory", description: "Show reasoning" },
    { label: "Concise", description: "Minimal prose" },
    { label: "Verbose", description: "All details" },
  ],
};

const Q_PRIVACY: AskUserQuestion = {
  question: "Enable privacy mode (no Mem0 / telemetry)?",
  header: "Privacy",
  multiSelect: false,
  options: [
    { label: "On", description: "Pakalon forgets every conversation" },
    { label: "Off", description: "Mem0 + telemetry on" },
  ],
};

const Q_INTEGRATIONS: AskUserQuestion = {
  question: "Set up integrations?",
  header: "Integrate",
  multiSelect: true,
  options: [
    { label: "GitHub", description: "PR comments + auto-merge" },
    { label: "Slack", description: "Build notifications" },
    { label: "Telegram", description: "Chat from your phone" },
    { label: "None", description: "Skip integrations" },
  ],
};

export async function runOnboarding(): Promise<{ completed: string[]; skipped: string[] }> {
  const completed: string[] = [];
  const skipped: string[] = [];

  const [login] = await askUserQuestion({ questions: [Q_LOGIN] });
  if (login.answer === "Yes, log me in") {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync("pakalon", ["login"], { stdio: "inherit" });
      completed.push("login");
    } catch {
      skipped.push("login");
    }
  } else if (login.answer === "No, create one") {
    const { default: open } = await import("open").catch(() => ({ default: null as any }));
    if (typeof open === "function") {
      await open("https://pakalon.com/signup");
    }
    completed.push("signup-link");
  } else {
    completed.push("self-hosted");
  }

  const [theme] = await askUserQuestion({ questions: [Q_THEME] });
  setTheme(theme.answer.toLowerCase().startsWith("light") ? "light" : theme.answer.toLowerCase().startsWith("dark") ? "dark" : "auto");
  completed.push("theme");

  const [out] = await askUserQuestion({ questions: [Q_OUTPUT] });
  setOutputStyle(out.answer.toLowerCase() as any);
  completed.push("output-style");

  const [priv] = await askUserQuestion({ questions: [Q_PRIVACY] });
  setPrivacyMode(priv.answer === "On");
  completed.push("privacy");

  const [integ] = await askUserQuestion({ questions: [Q_INTEGRATIONS] });
  const wanted = integ.selectedOptions;
  if (wanted.includes("GitHub")) await installGithubApp();
  if (wanted.includes("Slack")) await installSlackApp();
  if (wanted.includes("Telegram")) await connectTelegram({}).catch(() => undefined);
  completed.push("integrations");

  logger.info({ completed, skipped }, "Onboarding complete");
  return { completed, skipped };
}
