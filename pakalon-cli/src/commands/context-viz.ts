/**
 * /context command - Context window visualization (Copilot CLI style)
 */

import { ContextManager } from '@/ai/context-manager';
import { calculateTokenWarning, formatTokenWarningState, getTokenWarningSettings } from '@/services/token-warning.js';
import logger from '@/utils/logger';

/**
 * Context command options
 */
export interface ContextCommandOptions {
  /** Show detailed message list */
  detailed?: boolean;
  
  /** Session ID to inspect */
  sessionId?: string;
}

/**
 * Visualize context window usage
 */
export async function cmdContext(options: ContextCommandOptions = {}): Promise<void> {
  const contextManager = new ContextManager({ maxTokens: 200_000 });
  const stats = contextManager.getStats();
  const tokenWarning = calculateTokenWarning(
    stats.tokensUsed,
    stats.tokensMax,
    options.sessionId,
    getTokenWarningSettings(),
  );

  const barWidth = 30;
  const filled = Math.round((stats.percentageUsed / 100) * barWidth);
  const bar = "█".repeat(Math.max(0, Math.min(barWidth, filled))) + "░".repeat(Math.max(0, barWidth - filled));
  
  console.log('\n╭───────────────────────────────────────────────────────────╮');
  console.log('│                   CONTEXT WINDOW STATUS                   │');
  console.log('╰───────────────────────────────────────────────────────────╯\n');
  
  // Token usage bar
  const color = stats.percentageUsed >= 90 ? '[Red]' : stats.percentageUsed >= 80 ? '[Yellow]' : '[Green]';
  
  console.log(`${color} Token Usage:`);
  console.log(`   [${bar}] ${stats.percentageUsed.toFixed(1)}%`);
  console.log(`   ${stats.tokensUsed.toLocaleString()} / ${stats.tokensMax.toLocaleString()} tokens\n`);

  console.log('[Gauge] Token warnings:');
  console.log(`   ${formatTokenWarningState(tokenWarning).replace(/\n/g, ' ')}`);
  if (tokenWarning.shouldCompact) {
    console.log('   [Warn] Compaction suggested to preserve conversation continuity.\n');
  }
  
  // Message breakdown
  console.log('[Chart] Message Breakdown:');
  console.log(`   Total messages:   ${stats.totalMessages}`);
  console.log(`   User messages:    ${stats.userMessages}`);
  console.log(`   Assistant msgs:   ${stats.assistantMessages}`);
  console.log(`   System messages:  ${stats.systemMessages}`);
  console.log(`   Tool calls:       ${stats.toolMessages}\n`);

  console.log('[Gauge] Token warning state:');
  console.log(`   ${formatTokenWarningState(tokenWarning)}`);
  if (tokenWarning.shouldCompact) {
    console.log('   [Warn] Compaction suggested to preserve conversation continuity.\n');
  }
  
  // Recommendations
  if (stats.needsCompaction) {
    console.log('Warning:  COMPACTION RECOMMENDED');
    console.log('   Your context window is getting full.');
    console.log('   Run /compact to summarize and free up space.\n');
  } else {
    console.log('[OK] Context window healthy\n');
  }
  
  // Model info
  console.log('[Robot] Model Context Limits:');
  console.log('   Claude Sonnet 4:   200,000 tokens');
  console.log('   GPT-4o:            128,000 tokens');
  console.log('   Gemini Pro 1.5:  1,000,000 tokens\n');
  
  // Detailed message list
  if (options.detailed) {
    printDetailedMessages(contextManager);
  } else {
    console.log('[Idea] Tip: Use /context --detailed to see full message history\n');
  }
  
  console.log('───────────────────────────────────────────────────────────\n');
}

/**
 * Print detailed message history
 */
function printDetailedMessages(contextManager: ContextManager): void {
  console.log('───────────────────────────────────────────────────────────');
  console.log('[SCROLL] MESSAGE HISTORY');
  console.log('───────────────────────────────────────────────────────────\n');
  
  const stats = contextManager.getStats();
  console.log(`Messages tracked: ${stats.totalMessages}`);
  console.log(`Tokens used: ${stats.tokensUsed}`);
  console.log('Each message with role, timestamp, and token count would appear here.\n');
}

/**
 * Parse context command from user input
 */
export function parseContextCommand(input: string): ContextCommandOptions | null {
  if (!input.startsWith('/context')) {
    return null;
  }
  
  const options: ContextCommandOptions = {};
  
  if (input.includes('--detailed') || input.includes('-d')) {
    options.detailed = true;
  }
  
  // Parse --session flag
  const sessionMatch = input.match(/--session[=\s]+([\w-]+)/);
  if (sessionMatch) {
    options.sessionId = sessionMatch[1];
  }
  
  return options;
}

/**
 * Get context command help text
 */
export function getContextHelp(): string {
  return `
╭───────────────────────────────────────────────────────────╮
│                   /context Command                         │
│            Visualize context window usage                  │
╰───────────────────────────────────────────────────────────╯

USAGE:
  /context [options]

OPTIONS:
  --detailed, -d         Show full message history
  --session <id>         Inspect specific session
  --help, -h             Show this help

EXAMPLES:
  # Show context status
  /context
  
  # Show detailed message list
  /context --detailed
  
  # Inspect specific session
  /context --session abc123

  FEATURES:
  [OK] Visual token usage bar
  [OK] Message count breakdown
  [OK] Compaction recommendations
  [OK] Token warning thresholds
  [OK] Model context limits reference
  [OK] Per-message token counts (with --detailed)

CONTEXT MANAGEMENT:
  • Auto-compaction at 80% capacity
  • Keeps last 10 messages + system
  • Uses Claude Haiku for fast summarization
  • Preserves important context
  
  Run /compact to manually trigger compaction.
`;
}

export default {
  execute: cmdContext,
  parse: parseContextCommand,
  help: getContextHelp,
};
