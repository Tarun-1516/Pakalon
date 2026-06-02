/**
 * AskUserQuestionTool — multi-choice Q&A for the agentic loop.
 *
 * Mirrors the reference AskUserQuestionTool. Each question has 2–4
 * predefined options plus an automatic "Other" option that allows a
 * free-form answer. Answers are persisted to mem0 so they influence
 * later phases.
 */
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const askUserQuestionOptionSchema = z.object({
  label: z.string().min(1).describe("Short label for the option (1-5 words)"),
  description: z.string().optional().describe("What this option means"),
  preview: z.string().optional().describe("Optional preview snippet shown beneath the option"),
});

export const askUserQuestionSchema = z.object({
  question: z.string().min(5).describe("The complete question to ask the user"),
  header: z.string().max(12).optional().describe("Very short label shown in the UI (max 12 chars)"),
  options: z
    .array(askUserQuestionOptionSchema)
    .min(2)
    .max(4)
    .describe("2-4 options to present to the user. An 'Other' option is added automatically."),
  multiSelect: z
    .boolean()
    .default(false)
    .describe("If true, the user can pick several options. If false, only one."),
});

export const askUserQuestionInputSchema = z.object({
  questions: z
    .array(askUserQuestionSchema)
    .min(1)
    .max(4)
    .describe("Questions to ask. Up to 4 questions per call."),
});

export type AskUserQuestionOption = z.infer<typeof askUserQuestionOptionSchema>;
export type AskUserQuestion = z.infer<typeof askUserQuestionSchema>;
export type AskUserQuestionInput = z.infer<typeof askUserQuestionInputSchema>;

export interface AskUserQuestionResult {
  question: string;
  header?: string;
  answer: string;
  selectedOptions: string[];
  freeForm: boolean;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const QUESTIONS_DIR = ".pakalon-agents/ai-agents/answers";

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger.warn({ err, dir }, "AskUserQuestionTool: could not create answers dir");
  }
}

function persistAnswer(projectDir: string, q: AskUserQuestion, result: AskUserQuestionResult): void {
  try {
    const dir = path.join(projectDir, QUESTIONS_DIR);
    ensureDir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = (q.header ?? q.question).replace(/[^a-z0-9-_]+/gi, "_").slice(0, 32);
    const file = path.join(dir, `${stamp}_${safe}.json`);
    fs.writeFileSync(file, JSON.stringify({ question: q.question, result, ts: Date.now() }, null, 2), "utf-8");
  } catch (err) {
    logger.warn({ err }, "AskUserQuestionTool: could not persist answer");
  }
}

// ---------------------------------------------------------------------------
// Mem0 hook (best-effort)
// ---------------------------------------------------------------------------

async function remember(projectDir: string, q: AskUserQuestion, result: AskUserQuestionResult): Promise<void> {
  try {
    // Lazy import so a missing mem0 dep doesn't break the tool.
    const mem0 = await import("@/memory/mem0-adapter.js").catch(() => null);
    if (!mem0) return;
    const fn = (mem0 as any).default?.remember ?? (mem0 as any).remember;
    if (typeof fn !== "function") return;
    await fn({
      content: `User answered "${q.question}" with: ${result.answer}`,
      tags: ["askuser", q.header ?? "q"],
      projectDir,
    });
  } catch (err) {
    logger.debug({ err }, "AskUserQuestionTool: mem0 remember failed (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// In-process prompt (non-TUI path)
// ---------------------------------------------------------------------------

/**
 * Prompt the user via the in-process AskUserGate. Falls back to reading
 * stdin directly when no TUI listener is registered.
 */
async function promptInProcess(question: AskUserQuestion): Promise<AskUserQuestionResult> {
  // Try the registered gate first
  const { askUserGate } = await import("@/tools/ask-user.js").catch(() => ({ askUserGate: null as any }));
  if (askUserGate) {
    const choices = ["Other", ...question.options.map((o) => o.label)];
    const raw = await askUserGate.ask(question.question, choices);
    const freeForm = raw === "Other" || !question.options.some((o) => o.label === raw);
    const selectedOptions = freeForm ? [] : [raw];
    return {
      question: question.question,
      header: question.header,
      answer: raw,
      selectedOptions,
      freeForm,
    };
  }

  // Fallback: synchronous readline over stdin
  const { default: readline } = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const header = question.header ? `[${question.header}] ` : "";
  const optionList = question.options.map((o, i) => `  ${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n");
  const promptText = `${header}${question.question}\n${optionList}\n  0) Other (free-form)\n> `;
  const ans: string = await new Promise((resolve) => rl.question(promptText, (a) => resolve(a.trim())));
  rl.close();
  const idx = Number.parseInt(ans, 10);
  if (Number.isFinite(idx) && idx >= 1 && idx <= question.options.length) {
    return {
      question: question.question,
      header: question.header,
      answer: question.options[idx - 1].label,
      selectedOptions: [question.options[idx - 1].label],
      freeForm: false,
    };
  }
  return {
    question: question.question,
    header: question.header,
    answer: ans || "(no answer)",
    selectedOptions: [],
    freeForm: true,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface AskUserQuestionArgs {
  questions: AskUserQuestion[];
  projectDir?: string;
}

export async function askUserQuestion(args: AskUserQuestionArgs): Promise<AskUserQuestionResult[]> {
  const projectDir = args.projectDir ?? process.cwd();
  const results: AskUserQuestionResult[] = [];
  for (const q of args.questions) {
    const result = await promptInProcess(q);
    persistAnswer(projectDir, q, result);
    await remember(projectDir, q, result);
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tool registration helper (used by tools/registry-new.ts)
// ---------------------------------------------------------------------------

export const AskUserQuestionToolDefinition = {
  name: "AskUserQuestion",
  description:
    "Ask the user one or more multiple-choice questions (2-4 options + 'Other'). " +
    "Use this whenever you need user input to make a decision or clarify a requirement. " +
    "Answers are persisted to project memory.",
  inputSchema: askUserQuestionInputSchema,
  run: async (input: AskUserQuestionInput, ctx: { projectDir?: string } = {}) => {
    return askUserQuestion({ questions: input.questions, projectDir: ctx.projectDir });
  },
};
