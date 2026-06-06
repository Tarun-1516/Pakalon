import type { CommandContext, CommandResult } from './types.js'
import {
  clearCostThresholdSettings,
  formatCostThresholdState,
  getCostThresholdSettings,
  getCostThresholdState,
  grantCostThresholdContinuation,
  parseCostThresholdAmount,
  setCostThresholdSettings,
} from '@/services/cost-threshold.js'
import { getUsageStats } from '@/commands/cost.js'

export const costThresholdCommand = {
  name: 'cost-threshold',
  aliases: ['costlimit', 'budget-threshold'],
  description: 'Set or view the session cost threshold',
  usage: '/cost-threshold [view|set <usd>|clear|mode <warn|confirm|pause>|continue]',
  category: 'session' as const,

  async execute(_context: CommandContext, args: string[]): Promise<CommandResult> {
    const subCommand = (args[0] ?? 'view').toLowerCase()
    const stats = getUsageStats()
    const spendUsd = stats.totalCost
    const settings = getCostThresholdSettings()

    if (subCommand === 'continue' || subCommand === 'resume') {
      grantCostThresholdContinuation()
      return {
        success: true,
        message: 'Cost-threshold continuation granted for the next prompt.',
      }
    }

    if (subCommand === 'clear' || subCommand === 'off' || subCommand === 'disable') {
      clearCostThresholdSettings()
      return {
        success: true,
        message: 'Cost threshold disabled.',
      }
    }

    if (subCommand === 'set' || subCommand === 'threshold') {
      const amount = parseCostThresholdAmount(args[1] ?? '')
      if (amount === null) {
        return {
          success: false,
          message: 'Usage: /cost-threshold set <usd>\nExample: /cost-threshold set 10',
        }
      }

      const mode = normalizeMode(args[2] ?? settings.mode)
      const updated = setCostThresholdSettings({ thresholdUsd: amount, mode })
      return {
        success: true,
        message: formatCostThresholdState(getCostThresholdState(spendUsd, updated)),
      }
    }

    if (subCommand === 'mode') {
      const mode = normalizeMode(args[1])
      const updated = setCostThresholdSettings({ mode })
      return {
        success: true,
        message: formatCostThresholdState(getCostThresholdState(spendUsd, updated)),
      }
    }

    if (subCommand === 'confirm' || subCommand === 'pause' || subCommand === 'warn') {
      const updated = setCostThresholdSettings({ mode: normalizeMode(subCommand) })
      return {
        success: true,
        message: formatCostThresholdState(getCostThresholdState(spendUsd, updated)),
      }
    }

    const current = getCostThresholdState(spendUsd, settings)
    return {
      success: true,
      message: formatCostThresholdState(current),
      data: {
        enabled: current.enabled,
        thresholdUsd: current.thresholdUsd,
        spendUsd: current.spendUsd,
        level: current.level,
        blocksContinuation: current.blocksContinuation,
      },
    }
  },
}

function normalizeMode(value?: string): 'warn' | 'confirm' | 'pause' {
  const mode = (value ?? 'warn').toLowerCase()
  if (mode === 'confirm' || mode === 'pause') return mode
  return 'warn'
}

export default costThresholdCommand
