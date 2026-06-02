/**
 * btw command — exposes the side-thread Q&A engine as a slash command.
 *
 * This is a thin wrapper over `btw` that:
 *   - Validates the question
 *   - Resolves the current parent session id from the runtime context
 *   - Subscribes the local event bus to progress events
 *   - Returns a structured CommandResult the chat UI can render
 */

import type { CommandDefinition, CommandContext, CommandResult } from "../commands/types.js";
import btw from "./index.js";

export const btwCommand: CommandDefinition = {
  name: "btw",
  description: "Ask a side-thread question without interrupting the main agent",
  usage: "/btw <question>",
  category: "session",
  async execute(context: CommandContext, args: string[]): Promise<CommandResult> {
    const question = args.join(" ").trim();
    if (!question) {
      return {
        success: false,
        message: "Usage: /btw <question>\n\nAsk a side-thread question without interrupting the main conversation.",
      };
    }

    const parentSessionId = context.sessionId ?? "unknown-session";

    const request = btw.enqueue(question, {
      parentSessionId,
      parentSnapshot: context.historySnapshot,
      tokenBudget: context.tokenBudget ?? 1_500,
      modelId: context.modelId,
    });

    btw.ask(question, {
      parentSessionId,
      parentSnapshot: context.historySnapshot,
      tokenBudget: context.tokenBudget ?? 1_500,
      modelId: context.modelId,
    })
      .then((result) => {
        context.notify?.({
          kind: "btw:result",
          requestId: request.id,
          result,
        });
      })
      .catch(() => {
        /* handled inside the manager */
      });

    return {
      success: true,
      message: `Side-thread question queued (id: ${request.id}).`,
      data: {
        type: "btw",
        requestId: request.id,
        question,
        parentSessionId,
      },
    };
  },
};

export default btwCommand;
