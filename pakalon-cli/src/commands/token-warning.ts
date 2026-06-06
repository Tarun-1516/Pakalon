import type { CommandContext, CommandResult } from "./types.js";
import {
  clearTokenWarningSettings,
  formatTokenWarningState,
  getTokenWarningSettings,
  calculateTokenWarning,
  parseTokenWarningRatio,
  setTokenWarningSettings,
} from "@/services/token-warning.js";

export const tokenWarningCommand = {
  name: "token-warning",
  aliases: ["token-limit", "token-warning-levels"],
  description: "Configure token usage warning thresholds",
  usage: "/token-warning [view|set <notice> <warning> <critical> <compact>|enable|disable|reset]",
  category: "session" as const,

  async execute(_context: CommandContext, args: string[]): Promise<CommandResult> {
    const subCommand = (args[0] ?? "view").toLowerCase();
    const settings = getTokenWarningSettings();

    if (subCommand === "enable" || subCommand === "on") {
      const updated = setTokenWarningSettings({ enabled: true });
      return { success: true, message: describeSettings(updated) };
    }

    if (subCommand === "disable" || subCommand === "off") {
      const updated = setTokenWarningSettings({ enabled: false });
      return { success: true, message: describeSettings(updated) };
    }

    if (subCommand === "reset") {
      clearTokenWarningSettings();
      return { success: true, message: "Token warning thresholds reset." };
    }

    if (subCommand === "set") {
      const notice = parseTokenWarningRatio(args[1] ?? "");
      const warning = parseTokenWarningRatio(args[2] ?? "");
      const critical = parseTokenWarningRatio(args[3] ?? "");
      const compact = parseTokenWarningRatio(args[4] ?? "");

      if (notice === null || warning === null || critical === null) {
        return {
          success: false,
          message: "Usage: /token-warning set <notice%> <warning%> <critical%> <compact%>",
        };
      }

      const updated = setTokenWarningSettings({
        noticeRatio: notice,
        warningRatio: warning,
        criticalRatio: critical,
        compactRatio: compact ?? settings.compactRatio,
      });
      return { success: true, message: describeSettings(updated) };
    }

    const current = calculateTokenWarning(0, 1, undefined, settings);
    return {
      success: true,
      message: formatTokenWarningState(current),
      data: {
        enabled: settings.enabled,
        noticeRatio: settings.noticeRatio,
        warningRatio: settings.warningRatio,
        criticalRatio: settings.criticalRatio,
        compactRatio: settings.compactRatio,
      },
    };
  },
};

function describeSettings(settings = getTokenWarningSettings()): string {
  return [
    `Token warning thresholds:`,
    `- notice: ${Math.round(settings.noticeRatio * 100)}%`,
    `- warning: ${Math.round(settings.warningRatio * 100)}%`,
    `- critical: ${Math.round(settings.criticalRatio * 100)}%`,
    `- compact: ${Math.round(settings.compactRatio * 100)}%`,
    `- enabled: ${settings.enabled ? "yes" : "no"}`,
  ].join("\n");
}

export default tokenWarningCommand;
