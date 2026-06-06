import { readStorage, updateStorage } from '@/auth/app-storage.js'

export type CostThresholdMode = 'warn' | 'confirm' | 'pause'

export interface CostThresholdSettings {
  thresholdUsd: number | null
  warningRatio: number
  mode: CostThresholdMode
}

export interface CostThresholdState {
  enabled: boolean
  thresholdUsd: number
  warningUsd: number
  spendUsd: number
  percentUsed: number
  warningPercentUsed: number
  level: 'normal' | 'approaching' | 'exceeded'
  mode: CostThresholdMode
  blocksContinuation: boolean
}

const STORAGE_KEY_THRESHOLD_USD = 'costThresholdUsd'
const STORAGE_KEY_WARNING_RATIO = 'costThresholdWarningRatio'
const STORAGE_KEY_MODE = 'costThresholdMode'

const DEFAULT_WARNING_RATIO = 0.8
const DEFAULT_MODE: CostThresholdMode = 'warn'
let oneTimeContinuationGranted = false

function clampWarningRatio(value: number | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) return DEFAULT_WARNING_RATIO
  return Math.min(0.99, Math.max(0.5, value ?? DEFAULT_WARNING_RATIO))
}

function normalizeThreshold(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value <= 0) return null
  return Math.round(value * 100) / 100
}

export function getCostThresholdSettings(): CostThresholdSettings {
  const storage = readStorage() as Record<string, unknown>
  return {
    thresholdUsd: normalizeThreshold(storage[STORAGE_KEY_THRESHOLD_USD]),
    warningRatio: clampWarningRatio(
      typeof storage[STORAGE_KEY_WARNING_RATIO] === 'number'
        ? storage[STORAGE_KEY_WARNING_RATIO]
        : undefined,
    ),
    mode:
      storage[STORAGE_KEY_MODE] === 'confirm' || storage[STORAGE_KEY_MODE] === 'pause'
        ? (storage[STORAGE_KEY_MODE] as CostThresholdMode)
        : DEFAULT_MODE,
  }
}

export function setCostThresholdSettings(
  next: Partial<CostThresholdSettings>,
): CostThresholdSettings {
  const current = getCostThresholdSettings()
  const merged: CostThresholdSettings = {
    thresholdUsd:
      next.thresholdUsd === undefined ? current.thresholdUsd : normalizeThreshold(next.thresholdUsd),
    warningRatio:
      next.warningRatio === undefined ? current.warningRatio : clampWarningRatio(next.warningRatio),
    mode: next.mode ?? current.mode,
  }

  updateStorage({
    [STORAGE_KEY_THRESHOLD_USD]: merged.thresholdUsd,
    [STORAGE_KEY_WARNING_RATIO]: merged.warningRatio,
    [STORAGE_KEY_MODE]: merged.mode,
  })

  return merged
}

export function clearCostThresholdSettings(): void {
  updateStorage({
    [STORAGE_KEY_THRESHOLD_USD]: null,
    [STORAGE_KEY_WARNING_RATIO]: DEFAULT_WARNING_RATIO,
    [STORAGE_KEY_MODE]: DEFAULT_MODE,
  })
  oneTimeContinuationGranted = false
}

export function grantCostThresholdContinuation(): void {
  oneTimeContinuationGranted = true
}

export function consumeCostThresholdContinuation(): boolean {
  if (!oneTimeContinuationGranted) return false
  oneTimeContinuationGranted = false
  return true
}

export function getCostThresholdState(
  spendUsd: number,
  settings = getCostThresholdSettings(),
): CostThresholdState {
  const thresholdUsd = settings.thresholdUsd
  if (!thresholdUsd) {
    return {
      enabled: false,
      thresholdUsd: 0,
      warningUsd: 0,
      spendUsd,
      percentUsed: 0,
      warningPercentUsed: 0,
      level: 'normal',
      mode: settings.mode,
      blocksContinuation: false,
    }
  }

  const warningUsd = thresholdUsd * settings.warningRatio
  const percentUsed = spendUsd / thresholdUsd
  const warningPercentUsed = warningUsd > 0 ? spendUsd / warningUsd : 0
  const level = spendUsd >= thresholdUsd ? 'exceeded' : spendUsd >= warningUsd ? 'approaching' : 'normal'

  return {
    enabled: true,
    thresholdUsd,
    warningUsd,
    spendUsd,
    percentUsed,
    warningPercentUsed,
    level,
    mode: settings.mode,
    blocksContinuation: level === 'exceeded' && settings.mode !== 'warn',
  }
}

export function formatCostThresholdState(state: CostThresholdState): string {
  if (!state.enabled) {
    return 'Cost threshold: disabled'
  }

  const pct = Math.round(state.percentUsed * 100)
  const warningPct = Math.round(state.warningPercentUsed * 100)
  const modeLabel = state.mode === 'warn' ? 'warn only' : state.mode === 'confirm' ? 'require confirmation' : 'pause'

  if (state.level === 'exceeded') {
    return `Cost threshold reached: $${state.spendUsd.toFixed(4)} / $${state.thresholdUsd.toFixed(2)} (${pct}%) · mode: ${modeLabel}`
  }

  if (state.level === 'approaching') {
    return `Cost threshold approaching: $${state.spendUsd.toFixed(4)} / $${state.thresholdUsd.toFixed(2)} (${pct}%) · warning at $${state.warningUsd.toFixed(2)} (${warningPct}%) · mode: ${modeLabel}`
  }

  return `Cost threshold: $${state.spendUsd.toFixed(4)} / $${state.thresholdUsd.toFixed(2)} (${pct}%) · warning at $${state.warningUsd.toFixed(2)} · mode: ${modeLabel}`
}

export function parseCostThresholdAmount(input: string): number | null {
  const normalized = input.trim().replace(/^[^\d.-]+/, '').replace(/[$,]/g, '')
  if (!normalized) return null
  const value = Number(normalized)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 100) / 100
}
