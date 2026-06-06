import { readStorage, updateStorage } from "@/auth/app-storage.js";

export type TokenWarningLevel = "ok" | "notice" | "warning" | "critical";

export interface TokenWarningSettings {
  noticeRatio: number;
  warningRatio: number;
  criticalRatio: number;
  compactRatio: number;
  enabled: boolean;
}

export interface SessionTokenUsageSnapshot {
  sessionId: string;
  usedTokens: number;
  totalTokens: number;
  usagePercent: number;
  updatedAt: number;
}

export interface TokenWarningState {
  sessionId?: string;
  usedTokens: number;
  totalTokens: number;
  remainingTokens: number;
  usagePercent: number;
  level: TokenWarningLevel;
  shouldCompact: boolean;
  message: string;
  compactMessage?: string;
}

const STORAGE_KEY_NOTICE_RATIO = "tokenWarningNoticeRatio";
const STORAGE_KEY_WARNING_RATIO = "tokenWarningWarningRatio";
const STORAGE_KEY_CRITICAL_RATIO = "tokenWarningCriticalRatio";
const STORAGE_KEY_COMPACT_RATIO = "tokenWarningCompactRatio";
const STORAGE_KEY_ENABLED = "tokenWarningEnabled";

const DEFAULT_SETTINGS: TokenWarningSettings = {
  noticeRatio: 0.75,
  warningRatio: 0.9,
  criticalRatio: 0.95,
  compactRatio: 0.85,
  enabled: true,
};

const sessionUsage = new Map<string, SessionTokenUsageSnapshot>();

function clampRatio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(0.99, Math.max(0.1, value));
}

function normalizePercentInput(value: number): number {
  return value > 1 ? value / 100 : value;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function getTokenWarningSettings(): TokenWarningSettings {
  const storage = readStorage() as Record<string, unknown>;
  return {
    noticeRatio: clampRatio(storage[STORAGE_KEY_NOTICE_RATIO], DEFAULT_SETTINGS.noticeRatio),
    warningRatio: clampRatio(storage[STORAGE_KEY_WARNING_RATIO], DEFAULT_SETTINGS.warningRatio),
    criticalRatio: clampRatio(storage[STORAGE_KEY_CRITICAL_RATIO], DEFAULT_SETTINGS.criticalRatio),
    compactRatio: clampRatio(storage[STORAGE_KEY_COMPACT_RATIO], DEFAULT_SETTINGS.compactRatio),
    enabled: typeof storage[STORAGE_KEY_ENABLED] === "boolean" ? Boolean(storage[STORAGE_KEY_ENABLED]) : DEFAULT_SETTINGS.enabled,
  };
}

export function setTokenWarningSettings(next: Partial<TokenWarningSettings>): TokenWarningSettings {
  const current = getTokenWarningSettings();
  const merged: TokenWarningSettings = {
    noticeRatio: next.noticeRatio === undefined ? current.noticeRatio : clampRatio(next.noticeRatio, current.noticeRatio),
    warningRatio: next.warningRatio === undefined ? current.warningRatio : clampRatio(next.warningRatio, current.warningRatio),
    criticalRatio: next.criticalRatio === undefined ? current.criticalRatio : clampRatio(next.criticalRatio, current.criticalRatio),
    compactRatio: next.compactRatio === undefined ? current.compactRatio : clampRatio(next.compactRatio, current.compactRatio),
    enabled: next.enabled ?? current.enabled,
  };

  updateStorage({
    [STORAGE_KEY_NOTICE_RATIO]: merged.noticeRatio,
    [STORAGE_KEY_WARNING_RATIO]: merged.warningRatio,
    [STORAGE_KEY_CRITICAL_RATIO]: merged.criticalRatio,
    [STORAGE_KEY_COMPACT_RATIO]: merged.compactRatio,
    [STORAGE_KEY_ENABLED]: merged.enabled,
  });

  return merged;
}

export function clearTokenWarningSettings(): void {
  updateStorage({
    [STORAGE_KEY_NOTICE_RATIO]: DEFAULT_SETTINGS.noticeRatio,
    [STORAGE_KEY_WARNING_RATIO]: DEFAULT_SETTINGS.warningRatio,
    [STORAGE_KEY_CRITICAL_RATIO]: DEFAULT_SETTINGS.criticalRatio,
    [STORAGE_KEY_COMPACT_RATIO]: DEFAULT_SETTINGS.compactRatio,
    [STORAGE_KEY_ENABLED]: DEFAULT_SETTINGS.enabled,
  });
}

export function recordSessionTokenUsage(
  sessionId: string,
  usedTokens: number,
  totalTokens: number,
): SessionTokenUsageSnapshot {
  const safeTotal = Math.max(1, Math.floor(totalTokens));
  const safeUsed = Math.max(0, Math.min(Math.floor(usedTokens), safeTotal));
  const snapshot: SessionTokenUsageSnapshot = {
    sessionId,
    usedTokens: safeUsed,
    totalTokens: safeTotal,
    usagePercent: safeUsed / safeTotal,
    updatedAt: Date.now(),
  };
  sessionUsage.set(sessionId, snapshot);
  return snapshot;
}

export function getSessionTokenUsage(sessionId: string): SessionTokenUsageSnapshot | undefined {
  return sessionUsage.get(sessionId);
}

export function clearSessionTokenUsage(sessionId?: string): void {
  if (sessionId) {
    sessionUsage.delete(sessionId);
    return;
  }
  sessionUsage.clear();
}

export function calculateTokenWarning(
  usedTokens: number,
  totalTokens: number,
  sessionId?: string,
  settings = getTokenWarningSettings(),
): TokenWarningState {
  const safeTotal = Math.max(1, Math.floor(totalTokens));
  const safeUsed = Math.max(0, Math.min(Math.floor(usedTokens), safeTotal));
  const usagePercent = safeUsed / safeTotal;
  const remainingTokens = Math.max(0, safeTotal - safeUsed);

  if (sessionId) {
    recordSessionTokenUsage(sessionId, safeUsed, safeTotal);
  }

  if (!settings.enabled) {
    return {
      sessionId,
      usedTokens: safeUsed,
      totalTokens: safeTotal,
      remainingTokens,
      usagePercent,
      level: "ok",
      shouldCompact: false,
      message: `Token warnings disabled (${formatTokens(safeUsed)} / ${formatTokens(safeTotal)} tokens)`,
    };
  }

  let level: TokenWarningLevel = "ok";
  if (usagePercent >= settings.criticalRatio) level = "critical";
  else if (usagePercent >= settings.warningRatio) level = "warning";
  else if (usagePercent >= settings.noticeRatio) level = "notice";

  const shouldCompact = usagePercent >= settings.compactRatio;
  const pct = Math.round(usagePercent * 100);
  const message =
    level === "critical"
      ? `Critical context usage: ${formatTokens(safeUsed)} / ${formatTokens(safeTotal)} tokens (${pct}%)`
      : level === "warning"
        ? `Context window warning: ${formatTokens(safeUsed)} / ${formatTokens(safeTotal)} tokens (${pct}%)`
        : level === "notice"
          ? `Context window approaching limit: ${formatTokens(safeUsed)} / ${formatTokens(safeTotal)} tokens (${pct}%)`
          : `Context window healthy: ${formatTokens(safeUsed)} / ${formatTokens(safeTotal)} tokens (${pct}%)`;

  return {
    sessionId,
    usedTokens: safeUsed,
    totalTokens: safeTotal,
    remainingTokens,
    usagePercent,
    level,
    shouldCompact,
    message,
    compactMessage: shouldCompact
      ? `Compaction recommended at ${Math.round(settings.compactRatio * 100)}% usage.`
      : undefined,
  };
}

export function formatTokenWarningState(state: TokenWarningState): string {
  const pct = Math.round(state.usagePercent * 100);
  const base = `${state.message}`;
  if (state.shouldCompact && state.compactMessage) {
    return `${base}\n${state.compactMessage} (${pct}% used, ${formatTokens(state.remainingTokens)} remaining)`;
  }
  return base;
}

export function parseTokenWarningRatio(input: string): number | null {
  const raw = input.trim().replace(/%$/, "");
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const ratio = normalizePercentInput(value);
  return Math.min(0.99, Math.max(0.1, ratio));
}
