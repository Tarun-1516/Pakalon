/**
 * Commands Index for Pakalon CLI
 * 
 * Central export for all commands.
 */

// Types
export * from "./types.js";

// Session Commands
export { clearCommand, clearConversation, clearCaches, clearSessionCaches, registerCache, unregisterCache } from "./clear.js";
export { exitCommand, gracefulShutdown, registerCleanupHandler, unregisterCleanupHandler, setSessionSaveHandler } from "./exit.js";

// Navigation Commands
export { copyCommand, extractCodeBlocks, setClipboard, getAssistantMessages, buildCopyTargets } from "./copy.js";
export { diffCommand, getGitDiff, getStagedDiff, getCommitDiff, computeDiff, formatDiff } from "./diff.js";

// Info Commands
export { helpCommand, registerCommand, getCommand, getAllCommands, formatCommandList, formatHelpOverview } from "./help.js";
export { costCommand, usageCommand, statsCommand, calculateCost, recordUsage, getUsageStats, resetUsage } from "./cost.js";
export { costThresholdCommand } from "./cost-threshold.js";
export { tokenWarningCommand } from "./token-warning.js";
export { versionCommand, themeCommand, loadTheme, saveTheme, getTheme, getThemeNames, THEMES } from "./version-theme.js";
export { parityCommands } from "./parity.js";

// Auth Commands
export { loginCommand, logoutCommand, whoamiCommand, saveAuthState, loadAuthState, clearAuthState, getCurrentAuth, isAuthenticated } from "./auth.js";

// MCP & Skills Commands
export { mcpCommand, loadMcpConfig, saveMcpConfig, startMcpServer, stopMcpServer, restartMcpServer, getAllMcpServerStatuses } from "./mcp.js";
export { skillsCommand, discoverAllSkills, enableSkill, disableSkill, getSkill, getActiveSkills, getSkillByTrigger } from "./skills-cmd.js";
export { pakalonCommand } from "./pakalon.js";
export { pakalonAgentsCommand } from "./pakalon-agents.js";
export { phaseCommands } from "./phases.js";
export { updateCommand } from "./update.js";
export { connectCommandDefinition, connectEndCommandDefinition } from "./connect.js";
export { automationsCommand } from "./automations/index.js";
export { historyCommand } from "./history.js";
export { newSessionCommand, resumeCommand, sessionCommand } from "./session.js";
export { modelsCommand } from "./models.js";
export { penpotCommand } from "./penpot.js";
export { webCommand } from "./web.js";
export { undoCommand } from "./undo.js";
export { doctorCommand } from "./doctor.js";
export { installCommand } from "./install.js";

// Billing Command
export { billingCommand } from "./billing.js";

// Media Analysis Commands
export { analyzeImageCommand, cmdAnalyzeImage } from "./analyze-image.js";
export { analyzeVideoCommand, cmdAnalyzeVideo } from "./analyze-video.js";

// Image Generation Command
export { imageCommandDefinition } from "./image.js";

// Local Models Command
export { localModelsCommandDefinition } from "./local-models.js";

// Security Scan Command
export { securityScanCommandDefinition } from "./security-scan.js";

// Voice Command
export { voiceCommand, cmdVoice } from "./voice.js";

// Teleport Command
export { teleportCommand, cmdTeleport } from "./teleport-cmd.js";

// Multi-session Command
export { multiSessionCommand } from "./multi-session.js";
export { autoDreamCommand, cmdAutoDream } from "./auto-dream.js";

// ---------------------------------------------------------------------------
// Command Registry
// ---------------------------------------------------------------------------

import type { CommandDefinition, CommandResult, CommandContext } from "./types.js";
import { clearCommand } from "./clear.js";
import { exitCommand } from "./exit.js";
import { copyCommand } from "./copy.js";
import { diffCommand } from "./diff.js";
import { helpCommand } from "./help.js";
import { costCommand, usageCommand, statsCommand } from "./cost.js";
import { costThresholdCommand } from "./cost-threshold.js";
import { tokenWarningCommand } from "./token-warning.js";
import { versionCommand, themeCommand } from "./version-theme.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./auth.js";
import { mcpCommand } from "./mcp.js";
import { skillsCommand } from "./skills-cmd.js";
import { pakalonCommand } from "./pakalon.js";
import { pakalonAgentsCommand } from "./pakalon-agents.js";
import { parityCommands } from "./parity.js";
import { buildCommand } from "./build.js";
import { auditorCommand } from "./auditor.js";
import { ansCommandDefinition } from "./ans.js";
import { updateCommand } from "./update.js";
import { connectCommandDefinition, connectEndCommandDefinition } from "./connect.js";
import { phaseCommands } from "./phases.js";
import { automationsCommand } from "./automations/index.js";
import { workflowsCommand } from "./workflows/index.js";
import { billingCommand } from "./billing.js";
import { analyzeImageCommand } from "./analyze-image.js";
import { analyzeVideoCommand } from "./analyze-video.js";
import { imageCommandDefinition } from "./image.js";
import { localModelsCommandDefinition } from "./local-models.js";
import { securityScanCommandDefinition } from "./security-scan.js";
import { voiceCommand } from "./voice.js";
import { teleportCommand } from "./teleport-cmd.js";
import { multiSessionCommand } from "./multi-session.js";
import { autoDreamCommand } from "./auto-dream.js";
import designUpdateCommand from "./design-update.js";
import { historyCommand } from "./history.js";
import { newSessionCommand, resumeCommand, sessionCommand } from "./session.js";
import { modelsCommand } from "./models.js";
import { penpotCommand } from "./penpot.js";
import { webCommand } from "./web.js";
import { undoCommand } from "./undo.js";
import { doctorCommand } from "./doctor.js";
import { installCommand } from "./install.js";
import { sandboxCommand } from "./sandbox.js";
import advisorCommand from "./advisor.js";
import { reviewCommand } from "./review.js";
import shareCommand from "./share/index.js";
import commitPushPrCommand from "./commit-push-pr.js";
import onboardingCommand from "./onboarding.js";
import bughunterCommand from "./bughunter/index.js";
import securityReviewCommand from "./security-review.js";
import privacySettingsCommand from "./privacy-settings/index.js";
import { contextCommand, contextNonInteractiveCommand } from "./context/index.js";

// ---------------------------------------------------------------------------
// All Built-in Commands
// ---------------------------------------------------------------------------

export const builtinCommands: CommandDefinition[] = [
  // Session
  clearCommand as unknown as CommandDefinition,
  exitCommand as unknown as CommandDefinition,
  newSessionCommand,
  historyCommand,
  sessionCommand,
  resumeCommand,
  undoCommand,
  
  // Navigation
  copyCommand as unknown as CommandDefinition,
  diffCommand as unknown as CommandDefinition,
  
  // Info
  helpCommand as unknown as CommandDefinition,
  costCommand as unknown as CommandDefinition,
  costThresholdCommand as unknown as CommandDefinition,
  tokenWarningCommand as unknown as CommandDefinition,
  usageCommand as unknown as CommandDefinition,
  statsCommand as unknown as CommandDefinition,
  versionCommand as unknown as CommandDefinition,
  themeCommand as unknown as CommandDefinition,
  
  // Auth
  loginCommand as unknown as CommandDefinition,
  logoutCommand as unknown as CommandDefinition,
  whoamiCommand as unknown as CommandDefinition,
  
  // MCP & Skills
  mcpCommand as unknown as CommandDefinition,
  skillsCommand as unknown as CommandDefinition,
  pakalonCommand as unknown as CommandDefinition,
  pakalonAgentsCommand as unknown as CommandDefinition,

  // Claude-parity compatibility commands that are runtime-safe in Pakalon
  ...parityCommands,

  // Build pipeline
  buildCommand as unknown as CommandDefinition,
  ...phaseCommands,
  updateCommand,
  webCommand,

  // Design updates
  designUpdateCommand,

// Auditing
  auditorCommand as unknown as CommandDefinition,

  // Session - side thread Q&A
  ansCommandDefinition,

  // Runtime integrations
  connectCommandDefinition,
  connectEndCommandDefinition,
  penpotCommand,
  doctorCommand,
  installCommand,

// Automations
   automationsCommand as unknown as CommandDefinition,
 
   // Workflows
   workflowsCommand as unknown as CommandDefinition,
 
   // Billing
   billingCommand as unknown as CommandDefinition,
   modelsCommand,
 
   // Media Analysis
  analyzeImageCommand as unknown as CommandDefinition,
  analyzeVideoCommand as unknown as CommandDefinition,

  // Image Generation
  imageCommandDefinition as unknown as CommandDefinition,

  // Local Models
  localModelsCommandDefinition as unknown as CommandDefinition,

  // Security Scan
  securityScanCommandDefinition as unknown as CommandDefinition,

  // Voice
  voiceCommand as unknown as CommandDefinition,

  // Teleport
  teleportCommand as unknown as CommandDefinition,

  // Multi-session
  multiSessionCommand as unknown as CommandDefinition,

   // Background memory consolidation
   autoDreamCommand,

   // AIO Sandbox status
   sandboxCommand,

   // Additional registered commands
   advisorCommand as unknown as CommandDefinition,
   reviewCommand as unknown as CommandDefinition,
   shareCommand as unknown as CommandDefinition,
   commitPushPrCommand as unknown as CommandDefinition,
   onboardingCommand as unknown as CommandDefinition,
   bughunterCommand as unknown as CommandDefinition,
   securityReviewCommand as unknown as CommandDefinition,
   privacySettingsCommand as unknown as CommandDefinition,
   contextCommand as unknown as CommandDefinition,
];

// ---------------------------------------------------------------------------
// Command Lookup
// ---------------------------------------------------------------------------

const commandMap = new Map<string, CommandDefinition>();

function initCommandMap(): void {
  for (const cmd of builtinCommands) {
    commandMap.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        commandMap.set(alias, cmd);
      }
    }
  }
}

initCommandMap();

export function findCommand(name: string): CommandDefinition | undefined {
  const normalized = name.toLowerCase().replace(/^\//, "");
  return commandMap.get(normalized);
}

export function listCommands(): CommandDefinition[] {
  return builtinCommands;
}

// ---------------------------------------------------------------------------
// Command Executor
// ---------------------------------------------------------------------------

export async function executeCommand(
  input: string,
  context: CommandContext
): Promise<CommandResult> {
  const trimmed = input.trim();
  
  if (!trimmed.startsWith("/")) {
    return {
      success: false,
      message: "Commands must start with /",
    };
  }
  
  const parts = trimmed.slice(1).split(/\s+/);
  const commandName = parts[0]!;
  const args = parts.slice(1);
  
  const command = findCommand(commandName);
  
  if (!command) {
    return {
      success: false,
      message: `Unknown command: /${commandName}\nType /help for available commands.`,
    };
  }

  context.startCommand?.(commandName);
  
  try {
    const result = await command.execute(context, args);
    context.completeCommand?.(commandName);
    return result;
  } catch (error) {
    context.completeCommand?.(commandName);
    return {
      success: false,
      message: `Command error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Default Export
// ---------------------------------------------------------------------------

export default {
  builtinCommands,
  findCommand,
  listCommands,
  executeCommand,
};
