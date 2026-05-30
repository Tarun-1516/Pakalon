/**
 * Prompt Suggestion utilities for pakalon-cli
 */

import { getPromptSuggestions, type SuggestionContext } from "./index.js";

/**
 * Get contextual suggestions based on conversation history
 */
export function getContextualSuggestions(
  history: string[],
  currentInput: string
): string[] {
  const context: SuggestionContext = {
    currentPrompt: currentInput,
    previousPrompts: history.slice(-5),
  };

  const suggestions = getPromptSuggestions(context);
  return suggestions.map((s) => s.text);
}

/**
 * Detect if user might want to continue a thought
 */
export function detectIncompleteThought(input: string): boolean {
  const incompletePatterns = [
    /and also$/i,
    /plus$/i,
    /additionally$/i,
    /also need$/i,
    /don't forget$/i,
  ];

  return incompletePatterns.some((pattern) => pattern.test(input.trim()));
}

/**
 * Suggest completions for partial inputs
 */
export function suggestCompletions(partial: string): string[] {
  const completions: string[] = [];
  const partialLower = partial.toLowerCase();

  if (partialLower.startsWith("cre")) {
    completions.push("create a new component");
    completions.push("create a database migration");
    completions.push("create an API endpoint");
  }

  if (partialLower.startsWith("fix")) {
    completions.push("fix the bug in");
    completions.push("fix the type error");
    completions.push("fix the failing test");
  }

  if (partialLower.startsWith("add")) {
    completions.push("add error handling to");
    completions.push("add unit tests for");
    completions.push("add input validation");
  }

  return completions;
}
