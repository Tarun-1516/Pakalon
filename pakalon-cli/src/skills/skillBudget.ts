/**
 * Skill Budget Management
 * 
 * Manages skill listing budget to prevent context window bloat.
 * Modeled after claude's SKILL_BUDGET_CONTEXT_PERCENT.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Skill listing gets 1% of the context window (in characters) */
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01;

/** Characters per token approximation */
export const CHARS_PER_TOKEN = 4;

/** Default character budget (fallback: 1% of 200k × 4) */
export const DEFAULT_CHAR_BUDGET = 8_000;

/** Per-entry hard cap for skill descriptions */
export const MAX_LISTING_DESC_CHARS = 250;

/** Minimum description length before truncation */
export const MIN_DESC_LENGTH = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillInfo {
  /** Skill name */
  name: string;
  /** Skill description */
  description: string;
  /** Source type */
  source?: 'bundled' | 'plugin' | 'user';
}

export interface SkillBudgetConfig {
  /** Context window tokens */
  contextWindowTokens?: number;
  /** Override budget (characters) */
  charBudget?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate character budget for skill listings
 */
export function getCharBudget(config?: SkillBudgetConfig): number {
  if (config?.charBudget) {
    return config.charBudget;
  }
  
  if (config?.contextWindowTokens) {
    return Math.floor(
      config.contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    );
  }
  
  return DEFAULT_CHAR_BUDGET;
}

/**
 * Truncate a string to max length with ellipsis
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Get command description with truncation
 */
export function getCommandDescription(skill: SkillInfo): string {
  const desc = skill.description.length > MAX_LISTING_DESC_CHARS
    ? skill.description.slice(0, MAX_LISTING_DESC_CHARS - 1) + '…'
    : skill.description;
  return `- ${skill.name}: ${desc}`;
}

/**
 * Format skill listings within budget
 */
export function formatSkillListings(
  skills: SkillInfo[],
  config?: SkillBudgetConfig,
): string {
  if (skills.length === 0) return '';

  const budget = getCharBudget(config);

  // Try full descriptions first
  const fullEntries = skills.map(s => ({
    skill: s,
    full: getCommandDescription(s),
  }));
  
  const fullTotal = fullEntries.reduce((sum, e) => sum + e.full.length, 0) + (fullEntries.length - 1);

  if (fullTotal <= budget) {
    return fullEntries.map(e => e.full).join('\n');
  }

  // Partition into bundled (never truncated) and rest
  const bundledIndices = new Set<number>();
  const restSkills: SkillInfo[] = [];
  
  for (let i = 0; i < skills.length; i++) {
    if (skills[i].source === 'bundled') {
      bundledIndices.add(i);
    } else {
      restSkills.push(skills[i]);
    }
  }

  // Compute space used by bundled skills
  const bundledChars = fullEntries.reduce(
    (sum, e, i) => bundledIndices.has(i) ? sum + e.full.length + 1 : sum,
    0,
  );
  const remainingBudget = budget - bundledChars;

  if (restSkills.length === 0) {
    return fullEntries.map(e => e.full).join('\n');
  }

  // Calculate max description length for non-bundled
  const restNameOverhead = restSkills.reduce((sum, s) => sum + s.name.length + 4, 0) + (restSkills.length - 1);
  const availableForDescs = remainingBudget - restNameOverhead;
  const maxDescLen = Math.floor(availableForDescs / restSkills.length);

  if (maxDescLen < MIN_DESC_LENGTH) {
    // Extreme case: names only for non-bundled
    return skills
      .map((s, i) => bundledIndices.has(i) ? fullEntries[i]!.full : `- ${s.name}`)
      .join('\n');
  }

  // Truncate non-bundled descriptions
  return skills
    .map((s, i) => {
      if (bundledIndices.has(i)) return fullEntries[i]!.full;
      const desc = s.description.length > maxDescLen
        ? truncate(s.description, maxDescLen)
        : s.description;
      return `- ${s.name}: ${desc}`;
    })
    .join('\n');
}

/**
 * Count tokens in skill listing
 */
export function estimateSkillTokens(skills: SkillInfo[]): number {
  const text = formatSkillListings(skills);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export * as SkillBudget from './skillBudget.js';
