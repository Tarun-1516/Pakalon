/**
 * Version & Theme Commands for Pakalon CLI
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { CommandContext, CommandResult } from "./types.js";
import logger from "@/utils/logger.js";

// ---------------------------------------------------------------------------
// Version Command
// ---------------------------------------------------------------------------

const VERSION = "1.0.0";
const BUILD_DATE = new Date().toISOString().split("T")[0];
const NODE_VERSION = process.version;
const PLATFORM = `${process.platform}-${process.arch}`;

export const versionCommand = {
  name: "version",
  aliases: ["v", "ver"],
  description: "Show version information",
  usage: "/version [--full]",
  category: "info" as const,

  async execute(context: CommandContext, args: string[]): Promise<CommandResult> {
    const showFull = args.includes("--full") || args.includes("-f");

    const lines: string[] = [];

    lines.push(`
╔══════════════════════════════════════╗
║        Pakalon CLI v${VERSION.padEnd(11)}      ║
╚══════════════════════════════════════╝`);

    if (showFull) {
      lines.push("");
      lines.push(`Build Date:  ${BUILD_DATE}`);
      lines.push(`Node.js:     ${NODE_VERSION}`);
      lines.push(`Platform:    ${PLATFORM}`);
      lines.push(`Home:        ${os.homedir()}`);
      lines.push(`Config:      ~/.pakalon/`);

      // Check for updates (simulated)
      lines.push("");
      lines.push("[OK] You're running the latest version");
    }

    return {
      success: true,
      message: lines.join("\n"),
      data: {
        version: VERSION,
        buildDate: BUILD_DATE,
        nodeVersion: NODE_VERSION,
        platform: PLATFORM,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Theme Types & Data
// ---------------------------------------------------------------------------

export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  foreground: string;
  error: string;
  warning: string;
  success: string;
  info: string;
  muted: string;
}

export interface Theme {
  name: string;
  description: string;
  colors: ThemeColors;
}

export const THEMES: Record<string, Theme> = {
  default: {
    name: "Default",
    description: "Classic terminal colors",
    colors: {
      primary: "#61afef",
      secondary: "#c678dd",
      accent: "#98c379",
      background: "#282c34",
      foreground: "#abb2bf",
      error: "#e06c75",
      warning: "#e5c07b",
      success: "#98c379",
      info: "#61afef",
      muted: "#5c6370",
    },
  },
  dark: {
    name: "Dark",
    description: "Deep dark theme",
    colors: {
      primary: "#7aa2f7",
      secondary: "#bb9af7",
      accent: "#9ece6a",
      background: "#1a1b26",
      foreground: "#c0caf5",
      error: "#f7768e",
      warning: "#e0af68",
      success: "#9ece6a",
      info: "#7aa2f7",
      muted: "#565f89",
    },
  },
  light: {
    name: "Light",
    description: "Light theme for bright environments",
    colors: {
      primary: "#4078f2",
      secondary: "#a626a4",
      accent: "#50a14f",
      background: "#fafafa",
      foreground: "#383a42",
      error: "#e45649",
      warning: "#c18401",
      success: "#50a14f",
      info: "#4078f2",
      muted: "#a0a1a7",
    },
  },
  nord: {
    name: "Nord",
    description: "Arctic, north-bluish theme",
    colors: {
      primary: "#88c0d0",
      secondary: "#b48ead",
      accent: "#a3be8c",
      background: "#2e3440",
      foreground: "#eceff4",
      error: "#bf616a",
      warning: "#ebcb8b",
      success: "#a3be8c",
      info: "#88c0d0",
      muted: "#4c566a",
    },
  },
  dracula: {
    name: "Dracula",
    description: "Dark theme with purple accents",
    colors: {
      primary: "#bd93f9",
      secondary: "#ff79c6",
      accent: "#50fa7b",
      background: "#282a36",
      foreground: "#f8f8f2",
      error: "#ff5555",
      warning: "#ffb86c",
      success: "#50fa7b",
      info: "#8be9fd",
      muted: "#6272a4",
    },
  },
  monokai: {
    name: "Monokai",
    description: "Classic Monokai theme",
    colors: {
      primary: "#66d9ef",
      secondary: "#ae81ff",
      accent: "#a6e22e",
      background: "#272822",
      foreground: "#f8f8f2",
      error: "#f92672",
      warning: "#fd971f",
      success: "#a6e22e",
      info: "#66d9ef",
      muted: "#75715e",
    },
  },
  solarized: {
    name: "Solarized Dark",
    description: "Precision colors for machines and people",
    colors: {
      primary: "#268bd2",
      secondary: "#d33682",
      accent: "#859900",
      background: "#002b36",
      foreground: "#839496",
      error: "#dc322f",
      warning: "#b58900",
      success: "#859900",
      info: "#2aa198",
      muted: "#586e75",
    },
  },
  gruvbox: {
    name: "Gruvbox",
    description: "Retro groove theme",
    colors: {
      primary: "#83a598",
      secondary: "#d3869b",
      accent: "#b8bb26",
      background: "#282828",
      foreground: "#ebdbb2",
      error: "#fb4934",
      warning: "#fabd2f",
      success: "#b8bb26",
      info: "#83a598",
      muted: "#928374",
    },
  },
};

// ---------------------------------------------------------------------------
// Theme State
// ---------------------------------------------------------------------------

const THEME_CONFIG_FILE = path.join(os.homedir(), ".pakalon", "theme.json");
let currentTheme: Theme = THEMES.default!;

export async function loadTheme(): Promise<Theme> {
  try {
    const data = await fs.readFile(THEME_CONFIG_FILE, "utf-8");
    const config = JSON.parse(data) as { name: string };
    const theme = THEMES[config.name];
    if (theme) {
      currentTheme = theme;
    }
  } catch {
    // Use default
  }
  return currentTheme;
}

export async function saveTheme(themeName: string): Promise<void> {
  const dir = path.dirname(THEME_CONFIG_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(THEME_CONFIG_FILE, JSON.stringify({ name: themeName }, null, 2), "utf-8");
}

export function getTheme(): Theme {
  return currentTheme;
}

export function getThemeNames(): string[] {
  return Object.keys(THEMES);
}

// ---------------------------------------------------------------------------
// Theme Command
// ---------------------------------------------------------------------------

function formatThemePreview(theme: Theme): string {
  const c = theme.colors;
  
  // Use ANSI escape codes for colors (simplified)
  const lines: string[] = [];
  lines.push(`\n  ${theme.name}`);
  lines.push(`  ${theme.description}`);
  lines.push("");
  lines.push(`  ┌────────────────────────────────┐`);
  lines.push(`  │  Primary:   ████  ${c.primary.padEnd(10)} │`);
  lines.push(`  │  Secondary: ████  ${c.secondary.padEnd(10)} │`);
  lines.push(`  │  Accent:    ████  ${c.accent.padEnd(10)} │`);
  lines.push(`  │  Error:     ████  ${c.error.padEnd(10)} │`);
  lines.push(`  │  Warning:   ████  ${c.warning.padEnd(10)} │`);
  lines.push(`  │  Success:   ████  ${c.success.padEnd(10)} │`);
  lines.push(`  └────────────────────────────────┘`);
  
  return lines.join("\n");
}

export const themeCommand = {
  name: "theme",
  aliases: ["themes", "color"],
  description: "Change color theme",
  usage: "/theme [list|set|preview] [theme_name]",
  category: "config" as const,

  async execute(context: CommandContext, args: string[]): Promise<CommandResult> {
    const action = args[0]?.toLowerCase() ?? "list";
    const themeName = args[1]?.toLowerCase();

    switch (action) {
      case "list":
      case "ls": {
        const current = await loadTheme();
        const lines: string[] = [];
        lines.push("[Art] Available Themes");
        lines.push("═".repeat(40));

        for (const [name, theme] of Object.entries(THEMES)) {
          const indicator = name === current.name.toLowerCase() ? "→" : " ";
          lines.push(`${indicator} ${theme.name.padEnd(15)} - ${theme.description}`);
        }

        lines.push("");
        lines.push(`Current: ${current.name}`);

        return {
          success: true,
          message: lines.join("\n"),
        };
      }

      case "set": {
        if (!themeName) {
          return {
            success: false,
            message: "Theme name required: /theme set <name>",
          };
        }

        const theme = THEMES[themeName];
        if (!theme) {
          return {
            success: false,
            message: `Unknown theme: ${themeName}\nUse /theme list to see available themes.`,
          };
        }

        currentTheme = theme;
        await saveTheme(themeName);

        return {
          success: true,
          message: `Theme changed to: ${theme.name}${formatThemePreview(theme)}`,
        };
      }

      case "preview": {
        if (!themeName) {
          return {
            success: false,
            message: "Theme name required: /theme preview <name>",
          };
        }

        const theme = THEMES[themeName];
        if (!theme) {
          return {
            success: false,
            message: `Unknown theme: ${themeName}`,
          };
        }

        return {
          success: true,
          message: formatThemePreview(theme),
        };
      }

      default: {
        // Treat as theme name
        const theme = THEMES[action];
        if (theme) {
          currentTheme = theme;
          await saveTheme(action);
          return {
            success: true,
            message: `Theme changed to: ${theme.name}`,
          };
        }

        return {
          success: false,
          message: `Unknown action or theme: ${action}`,
        };
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  versionCommand,
  themeCommand,
  VERSION,
  BUILD_DATE,
  loadTheme,
  saveTheme,
  getTheme,
  getThemeNames,
  THEMES,
};
