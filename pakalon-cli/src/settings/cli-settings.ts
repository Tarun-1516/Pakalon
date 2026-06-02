/**
 * /fast — toggle Fast Mode.
 *
 * In Fast Mode the agent uses a smaller, cheaper model and skips
 * long-running sub-agents. The setting is stored in
 * `~/.config/pakalon/settings.json` so it persists across sessions.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import logger from "@/utils/logger.js";

const SETTINGS = path.join(os.homedir(), ".config", "pakalon", "settings.json");

export interface Settings {
  defaultModel?: string;
  fastMode?: boolean;
  outputStyle?: "default" | "explanatory" | "concise" | "verbose";
  effortLevel?: "low" | "medium" | "high" | "max";
  theme?: "light" | "dark" | "auto";
  privacyMode?: boolean;
}

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, "utf-8")) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(settings: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), "utf-8");
}

export function isFastMode(): boolean {
  return readSettings().fastMode === true;
}

export function setFastMode(enabled: boolean): Settings {
  const s = readSettings();
  s.fastMode = enabled;
  if (enabled && !s.defaultModel) {
    // pick a fast default
    s.defaultModel = "anthropic/claude-3-5-haiku";
  }
  writeSettings(s);
  logger.info({ enabled }, "Fast mode toggled");
  return s;
}

export function setOutputStyle(style: NonNullable<Settings["outputStyle"]>): Settings {
  const s = readSettings();
  s.outputStyle = style;
  writeSettings(s);
  return s;
}

export function setEffortLevel(level: NonNullable<Settings["effortLevel"]>): Settings {
  const s = readSettings();
  s.effortLevel = level;
  writeSettings(s);
  return s;
}

export function setTheme(theme: NonNullable<Settings["theme"]>): Settings {
  const s = readSettings();
  s.theme = theme;
  writeSettings(s);
  return s;
}

export function setPrivacyMode(enabled: boolean): Settings {
  const s = readSettings();
  s.privacyMode = enabled;
  writeSettings(s);
  return s;
}
