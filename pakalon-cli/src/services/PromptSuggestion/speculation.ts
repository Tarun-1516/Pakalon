/**
 * Speculation Service for pakalon-cli
 *
 * Predicts what the user might want to do next based on context.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type Speculation = {
  action: string;
  confidence: number;
  reasoning: string;
};

// ============================================================================
// Speculation Service
// ============================================================================

/**
 * Speculate on next user action based on context
 */
export function speculateNextAction(context: {
  lastAction: string;
  currentFile?: string;
  projectType?: string;
}): Speculation[] {
  const speculations: Speculation[] = [];

  switch (context.lastAction) {
    case "edit":
      speculations.push({
        action: "save",
        confidence: 0.9,
        reasoning: "User typically saves after editing",
      });
      speculations.push({
        action: "run",
        confidence: 0.6,
        reasoning: "User may want to test changes",
      });
      break;

    case "create":
      speculations.push({
        action: "implement",
        confidence: 0.8,
        reasoning: "User typically implements after creating",
      });
      break;

    case "debug":
      speculations.push({
        action: "fix",
        confidence: 0.85,
        reasoning: "User typically fixes after debugging",
      });
      break;

    default:
      speculations.push({
        action: "continue",
        confidence: 0.5,
        reasoning: "User may continue current task",
      });
  }

  return speculations.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Predict file changes based on user intent
 */
export function predictFileChanges(intent: string): string[] {
  const changes: string[] = [];

  if (intent.includes("add feature")) {
    changes.push("Create new component file");
    changes.push("Update routing");
    changes.push("Add tests");
  }

  if (intent.includes("fix bug")) {
    changes.push("Identify root cause");
    changes.push("Apply fix");
    changes.push("Verify fix");
  }

  return changes;
}
