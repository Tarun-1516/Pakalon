/**
 * Prompt Suggestion Service for pakalon-cli
 *
 * Provides intelligent prompt suggestions based on context.
 * Analyzes user input and suggests relevant follow-up prompts.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type PromptSuggestion = {
  id: string;
  text: string;
  category: string;
  confidence: number;
};

export type SuggestionContext = {
  currentPrompt: string;
  previousPrompts: string[];
  projectType?: string;
  language?: string;
};

// ============================================================================
// Prompt Suggestion Service
// ============================================================================

/**
 * Get prompt suggestions based on context
 */
export function getPromptSuggestions(
  context: SuggestionContext
): PromptSuggestion[] {
  const suggestions: PromptSuggestion[] = [];

  // Analyze the current prompt for keywords
  const promptLower = context.currentPrompt.toLowerCase();

  // Add suggestions based on keywords
  if (promptLower.includes("create") || promptLower.includes("build")) {
    suggestions.push({
      id: "sug-1",
      text: "Generate unit tests for this code",
      category: "testing",
      confidence: 0.8,
    });
  }

  if (promptLower.includes("fix") || promptLower.includes("bug")) {
    suggestions.push({
      id: "sug-2",
      text: "Explain what was causing the issue",
      category: "explanation",
      confidence: 0.7,
    });
  }

  if (promptLower.includes("refactor")) {
    suggestions.push({
      id: "sug-3",
      text: "Add comprehensive error handling",
      category: "improvement",
      confidence: 0.75,
    });
  }

  // Add general suggestions
  suggestions.push({
    id: "sug-general-1",
    text: "Review this code for potential issues",
    category: "review",
    confidence: 0.5,
  });

  suggestions.push({
    id: "sug-general-2",
    text: "Optimize this code for performance",
    category: "optimization",
    confidence: 0.4,
  });

  // Sort by confidence
  suggestions.sort((a, b) => b.confidence - a.confidence);

  return suggestions.slice(0, 5); // Return top 5 suggestions
}

/**
 * Analyze prompt and extract intent
 */
export function analyzePromptIntent(prompt: string): {
  intent: string;
  entities: string[];
  confidence: number;
} {
  const promptLower = prompt.toLowerCase();
  let intent = "general";
  let confidence = 0.5;

  if (promptLower.includes("create") || promptLower.includes("build")) {
    intent = "creation";
    confidence = 0.8;
  } else if (promptLower.includes("fix") || promptLower.includes("debug")) {
    intent = "fixing";
    confidence = 0.8;
  } else if (promptLower.includes("explain") || promptLower.includes("how")) {
    intent = "explanation";
    confidence = 0.7;
  } else if (promptLower.includes("refactor") || promptLower.includes("improve")) {
    intent = "improvement";
    confidence = 0.7;
  } else if (promptLower.includes("test")) {
    intent = "testing";
    confidence = 0.75;
  }

  // Extract entities (simple keyword extraction)
  const entities: string[] = [];
  const keywords = ["api", "database", "auth", "ui", "component", "function"];
  for (const keyword of keywords) {
    if (promptLower.includes(keyword)) {
      entities.push(keyword);
    }
  }

  return { intent, entities, confidence };
}
