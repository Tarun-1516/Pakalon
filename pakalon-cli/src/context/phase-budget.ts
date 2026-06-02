/**
 * Per-phase token budget.
 *
 * CLI-req §"Context management" splits the per-session token budget
 * across the six phases using the policy:
 *   - 65% goes to the "new" content for the current phase
 *   - 35% goes to "existing" context (prior phases, plan.md, etc.)
 *   - 10% buffer for retries
 */
import logger from "@/utils/logger.js";

export interface PhaseBudget {
  phase: number;
  /** Total tokens available to this phase (in + out) */
  total: number;
  /** Tokens reserved for the "new" content of the current phase */
  newContent: number;
  /** Tokens reserved for prior phase context */
  existing: number;
  /** Spare tokens for retries */
  buffer: number;
}

export interface BudgetPlan {
  totalBudget: number;
  perPhase: PhaseBudget[];
}

const NEW_RATIO = 0.65;
const EXISTING_RATIO = 0.25;
const BUFFER_RATIO = 0.10;

export function planBudget(totalBudget: number): BudgetPlan {
  // Split the total budget evenly across the 6 phases
  const perPhaseTotal = Math.floor(totalBudget / 6);
  const perPhase: PhaseBudget[] = [];
  for (let phase = 1; phase <= 6; phase++) {
    perPhase.push({
      phase,
      total: perPhaseTotal,
      newContent: Math.floor(perPhaseTotal * NEW_RATIO),
      existing: Math.floor(perPhaseTotal * EXISTING_RATIO),
      buffer: Math.floor(perPhaseTotal * BUFFER_RATIO),
    });
  }
  return { totalBudget, perPhase };
}

export function budgetFor(plan: BudgetPlan, phase: number): PhaseBudget {
  const b = plan.perPhase.find((p) => p.phase === phase);
  if (!b) {
    logger.warn({ phase }, "No budget planned for phase — returning zero");
    return { phase, total: 0, newContent: 0, existing: 0, buffer: 0 };
  }
  return b;
}

export function renderBudgetBar(budget: PhaseBudget, used: number): string {
  const pct = budget.total > 0 ? Math.min(1, used / budget.total) : 0;
  const width = 20;
  const filled = Math.round(pct * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `Phase ${budget.phase}: [${bar}] ${used.toLocaleString()} / ${budget.total.toLocaleString()} tokens`;
}
