/**
 * /snip — copy a code snippet to the clipboard, optionally with a
 * short AI-generated explanation.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { generateText } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import logger from "@/utils/logger.js";

const execFileAsync = promisify(execFile);

export interface SnipOptions {
  code: string;
  language?: string;
  explainWithAi?: boolean;
}

export interface SnipResult {
  clipboard: string;
  explanation?: string;
  ok: boolean;
}

export async function snipToClipboard(opts: SnipOptions): Promise<SnipResult> {
  let explanation: string | undefined;
  if (opts.explainWithAi) {
    try {
      const { text } = await generateText({
        model: openrouter("anthropic/claude-3-5-haiku"),
        prompt: `Explain the following ${opts.language ?? "code"} in 1-2 sentences:\n\n${opts.code}`,
        maxTokens: 256,
      });
      explanation = text;
    } catch (err) {
      logger.warn({ err }, "AI explanation failed");
    }
  }
  const blob = `\`\`\`${opts.language ?? ""}\n${opts.code}\n\`\`\`${explanation ? `\n\n${explanation}` : ""}`;
  try {
    const cmd = process.platform === "win32" ? "clip" : process.platform === "darwin" ? "pbcopy" : "wl-copy";
    await execFileAsync(cmd, [], { input: blob });
    return { clipboard: blob, explanation, ok: true };
  } catch (err) {
    return { clipboard: blob, explanation, ok: false };
  }
}
