import logger from "@/utils/logger.js";
import type {
  LayoutSlot,
  PaneLayoutConfig,
  TeammateProcessInfo,
} from "./types.js";

/**
 * TeammateLayoutManager — manages the visual layout of teammates.
 *
 * Determines which pane goes where, which window to use, and how to
 * arrange multiple teammates on screen. Works with tmux, iTerm2, and
 * Windows Terminal layout mechanisms.
 */

/**
 * A layout grid for arranging multiple teammates.
 */
export interface LayoutGrid {
  rows: number;
  cols: number;
  slots: LayoutSlot[];
}

/**
 * Layout manager for teammate visual arrangement.
 */
export class TeammateLayoutManager {
  private slots: Map<string, LayoutSlot> = new Map();
  private grid: LayoutGrid;
  private sessionName: string;

  constructor(sessionName = "pakalon-team") {
    this.sessionName = sessionName;
    this.grid = { rows: 1, cols: 1, slots: [] };
  }

  /**
   * Calculate the optimal grid layout for N teammates.
   */
  static calculateGrid(teammateCount: number): { rows: number; cols: number } {
    if (teammateCount <= 0) return { rows: 0, cols: 0 };
    if (teammateCount === 1) return { rows: 1, cols: 1 };
    if (teammateCount === 2) return { rows: 1, cols: 2 };
    if (teammateCount <= 4) return { rows: 2, cols: 2 };
    if (teammateCount <= 6) return { rows: 2, cols: 3 };
    if (teammateCount <= 9) return { rows: 3, cols: 3 };
    // For larger teams, use 4 columns
    const cols = 4;
    const rows = Math.ceil(teammateCount / cols);
    return { rows, cols };
  }

  /**
   * Assign a layout slot to a teammate.
   */
  assignSlot(teammateId: string, slot: Partial<LayoutSlot>): LayoutSlot {
    const existing = this.slots.get(teammateId);
    const fullSlot: LayoutSlot = {
      teammateId,
      row: slot.row ?? existing?.row ?? 0,
      col: slot.col ?? existing?.col ?? 0,
      width: slot.width ?? existing?.width ?? 1,
      height: slot.height ?? existing?.height ?? 1,
      window: slot.window ?? existing?.window,
      pane: slot.pane ?? existing?.pane,
    };
    this.slots.set(teammateId, fullSlot);
    return fullSlot;
  }

  /**
   * Remove a teammate from the layout.
   */
  removeSlot(teammateId: string): void {
    this.slots.delete(teammateId);
  }

  /**
   * Get the layout slot for a teammate.
   */
  getSlot(teammateId: string): LayoutSlot | undefined {
    return this.slots.get(teammateId);
  }

  /**
   * Get all assigned slots.
   */
  getAllSlots(): LayoutSlot[] {
    return Array.from(this.slots.values());
  }

  /**
   * Auto-assign layout positions for all given teammates.
   */
  autoLayout(teammates: TeammateProcessInfo[]): LayoutGrid {
    const { rows, cols } = TeammateLayoutManager.calculateGrid(teammates.length);
    this.grid = { rows, cols, slots: [] };

    for (let i = 0; i < teammates.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const slot = this.assignSlot(teammates[i].id, { row, col, width: 1, height: 1 });
      this.grid.slots.push(slot);
    }

    logger.debug(`[LayoutManager] Auto-layout: ${teammates.length} teammates in ${rows}x${cols} grid`);
    return this.grid;
  }

  /**
   * Get the pane layout command for tmux.
   */
  getTmuxLayoutCommand(): string {
    const slots = this.getAllSlots();
    if (slots.length <= 1) return "tiled";

    // Use tiled layout for simplicity with multiple panes
    return "tiled";
  }

  /**
   * Get the pane layout configuration for iTerm2.
   */
  getITermLayoutConfig(): PaneLayoutConfig[] {
    const slots = this.getAllSlots();
    return slots.map((slot) => ({
      position: (slot.col === 0 ? "bottom" : "right") as "bottom" | "right",
      sizePercent: Math.floor(100 / (this.grid.cols || 1)),
      targetPaneId: slot.pane,
    }));
  }

  /**
   * Get the layout description for display purposes.
   */
  getLayoutDescription(): string {
    const slots = this.getAllSlots();
    if (slots.length === 0) return "No teammates";
    if (slots.length === 1) return `1 teammate (single pane)`;
    return `${slots.length} teammates (${this.grid.rows}x${this.grid.cols} grid)`;
  }
}

/**
 * Create a layout manager and auto-layout the given teammates.
 */
export function createAutoLayout(
  teammates: TeammateProcessInfo[],
  sessionName?: string,
): TeammateLayoutManager {
  const manager = new TeammateLayoutManager(sessionName);
  manager.autoLayout(teammates);
  return manager;
}
