/**
 * Tips Service for pakalon-cli
 *
 * Provides contextual tips and hints to users.
 */

import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type Tip = {
  id: string;
  category: string;
  message: string;
  context?: string;
  priority: "low" | "medium" | "high";
};

export type TipsConfig = {
  /** Enable tips */
  enabled?: boolean;
  /** Show tips on startup */
  showOnStartup?: boolean;
  /** Maximum tips to show */
  maxTips?: number;
  /** Tips to exclude */
  excludeIds?: string[];
};

// ============================================================================
// Tips Service Implementation
// ============================================================================

class TipsService {
  private config: TipsConfig;
  private tips: Tip[] = [];
  private shownTips: Set<string> = new Set();

  constructor(config: TipsConfig = {}) {
    this.config = {
      enabled: true,
      showOnStartup: false,
      maxTips: 5,
      ...config,
    };

    this.loadDefaultTips();
    logger.info("[TipsService] Initialized with config:", this.config);
  }

  /**
   * Load default tips
   */
  private loadDefaultTips(): void {
    this.tips = [
      {
        id: "tip-shortcuts",
        category: "shortcuts",
        message: "Press Tab to switch between Chat, Plan, and Edit modes",
        priority: "high",
      },
      {
        id: "tip-slash",
        category: "commands",
        message: "Type /help to see all available slash commands",
        priority: "medium",
      },
      {
        id: "tip-undo",
        category: "commands",
        message: "Use /undo to revert the last code change",
        priority: "medium",
      },
      {
        id: "tip-session",
        category: "session",
        message: "Use /sessions to browse and resume previous sessions",
        priority: "medium",
      },
      {
        id: "tip-models",
        category: "models",
        message: "Use /models to switch between different AI models",
        priority: "low",
      },
      {
        id: "tip-compact",
        category: "context",
        message: "Use /compact to save context window space",
        priority: "low",
      },
      {
        id: "tip-voice",
        category: "voice",
        message: "Press Shift+Tab to enable voice mode",
        priority: "low",
      },
      {
        id: "tip-plan",
        category: "modes",
        message: "Plan mode only reads files - use Edit mode to make changes",
        priority: "medium",
      },
    ];
  }

  /**
   * Get tips for a specific context
   */
  getTipsForContext(context: string): Tip[] {
    if (!this.config.enabled) {
      return [];
    }

    const contextLower = context.toLowerCase();
    return this.tips
      .filter(
        (tip) =>
          !this.shownTips.has(tip.id) &&
          !(this.config.excludeIds ?? []).includes(tip.id) &&
          (tip.context?.toLowerCase().includes(contextLower) ||
            tip.category.toLowerCase().includes(contextLower))
      )
      .slice(0, this.config.maxTips);
  }

  /**
   * Get random tips
   */
  getRandomTips(count?: number): Tip[] {
    if (!this.config.enabled) {
      return [];
    }

    const availableTips = this.tips.filter(
      (tip) =>
        !this.shownTips.has(tip.id) &&
        !(this.config.excludeIds ?? []).includes(tip.id)
    );

    // Shuffle and return
    const shuffled = [...availableTips].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count ?? this.config.maxTips);
  }

  /**
   * Get startup tips
   */
  getStartupTips(): Tip[] {
    if (!this.config.showOnStartup) {
      return [];
    }

    return this.getRandomTips(3);
  }

  /**
   * Mark a tip as shown
   */
  markAsShown(tipId: string): void {
    this.shownTips.add(tipId);
  }

  /**
   * Mark multiple tips as shown
   */
  markMultipleAsShown(tipIds: string[]): void {
    for (const id of tipIds) {
      this.shownTips.add(id);
    }
  }

  /**
   * Reset shown tips
   */
  resetShownTips(): void {
    this.shownTips.clear();
    logger.info("[TipsService] Reset shown tips");
  }

  /**
   * Add a custom tip
   */
  addTip(tip: Tip): void {
    this.tips.push(tip);
    logger.info(`[TipsService] Added tip: ${tip.id}`);
  }

  /**
   * Remove a tip
   */
  removeTip(tipId: string): void {
    this.tips = this.tips.filter((t) => t.id !== tipId);
    logger.info(`[TipsService] Removed tip: ${tipId}`);
  }

  /**
   * Get all tips
   */
  getAllTips(): Tip[] {
    return [...this.tips];
  }

  /**
   * Get tips by category
   */
  getTipsByCategory(category: string): Tip[] {
    return this.tips.filter((t) => t.category === category);
  }

  /**
   * Get tips by priority
   */
  getTipsByPriority(priority: Tip["priority"]): Tip[] {
    return this.tips.filter((t) => t.priority === priority);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultService: TipsService | null = null;

/**
 * Get or create the default Tips service
 */
export function getTipsService(config?: TipsConfig): TipsService {
  if (!defaultService) {
    defaultService = new TipsService(config);
  }
  return defaultService;
}

/**
 * Create a new Tips service with custom config
 */
export function createTipsService(config: TipsConfig): TipsService {
  return new TipsService(config);
}
