/**
 * Phase 1 brainstorm — gathers user requirements through multi-choice Q&A.
 *
 * CLI-req §"Phase 1" requires that the planning phase ask the user at
 * least 10 multi-choice questions before producing plan.md. This module
 * enforces that minimum and persists every answer to mem0.
 */
import { BRAINSTORM_QUESTIONS, MIN_BRAINSTORM_QUESTIONS } from "@/tools/AskUserQuestionTool/prompt.js";
import {
  askUserQuestion,
  type AskUserQuestion,
  type AskUserQuestionResult,
} from "@/tools/AskUserQuestionTool/AskUserQuestionTool.js";
import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrainstormOptions {
  projectDir?: string;
  /** Skip the LLM-suggested extras and use only the curated list */
  useOnlyCurated?: boolean;
  /** Cap on the number of questions (CLI batches of ≤4) */
  maxQuestions?: number;
}

export interface BrainstormResult {
  questions: AskUserQuestion[];
  answers: AskUserQuestionResult[];
  /** Where the answers were written on disk */
  outputDir: string;
  /** Whether the min-10 requirement was satisfied */
  satisfied: boolean;
}

// ---------------------------------------------------------------------------
// Curated question set
// ---------------------------------------------------------------------------

/**
 * The questions to ask. We chunk in groups of 4 (the max per call) so
 * the UI is not overwhelming. The last group always includes the
 * "End Phase 1" gate question.
 */
export function chunkQuestions(questions: AskUserQuestion[]): AskUserQuestion[][] {
  const out: AskUserQuestion[][] = [];
  for (let i = 0; i < questions.length; i += 4) out.push(questions.slice(i, i + 4));
  return out;
}

// ---------------------------------------------------------------------------
// Brainstorm runner
// ---------------------------------------------------------------------------

export async function brainstorm(options: BrainstormOptions = {}): Promise<BrainstormResult> {
  const projectDir = options.projectDir ?? process.cwd();
  const questions: AskUserQuestion[] = BRAINSTORM_QUESTIONS.slice(0, options.maxQuestions ?? BRAINSTORM_QUESTIONS.length);

  if (questions.length < MIN_BRAINSTORM_QUESTIONS) {
    throw new Error(
      `Phase 1 requires at least ${MIN_BRAINSTORM_QUESTIONS} brainstorming questions, ` +
        `but only ${questions.length} were provided. Aborting before plan.md is generated.`,
    );
  }

  logger.info({ count: questions.length, projectDir }, "Phase 1: starting brainstorm");

  const allAnswers: AskUserQuestionResult[] = [];
  for (const chunk of chunkQuestions(questions)) {
    const results = await askUserQuestion({ questions: chunk, projectDir });
    allAnswers.push(...results);

    // Honour the "Pause for review" / "Revisit answers" choices
    const endQ = results.find((r) => r.question.toLowerCase().includes("finish building"));
    if (endQ) {
      if (endQ.answer === "Pause for review") {
        logger.info("Phase 1: user paused for review");
        break;
      }
      if (endQ.answer === "Revisit answers") {
        logger.info("Phase 1: user requested revisit — re-asking the last chunk");
        const revisit = await askUserQuestion({ questions: chunk, projectDir });
        // Replace the last chunk's answers
        allAnswers.splice(allAnswers.length - chunk.length, chunk.length, ...revisit);
      }
    }
  }

  const outputDir = await persist(projectDir, questions, allAnswers);

  return {
    questions,
    answers: allAnswers,
    outputDir,
    satisfied: allAnswers.length >= MIN_BRAINSTORM_QUESTIONS,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persist(
  projectDir: string,
  questions: AskUserQuestion[],
  answers: AskUserQuestionResult[],
): Promise<string> {
  const outDir = path.join(projectDir, ".pakalon-agents", "ai-agents", "phase-1");
  await fs.promises.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, "brainstorm.json");
  const payload = {
    schema: "phase1-brainstorm/v1",
    generatedAt: new Date().toISOString(),
    questions: questions.map((q) => ({ question: q.question, header: q.header, multiSelect: q.multiSelect })),
    answers,
  };
  await fs.promises.writeFile(file, JSON.stringify(payload, null, 2), "utf-8");
  return outDir;
}
