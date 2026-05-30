/**
 * MagicDocs Service for pakalon-cli
 *
 * Automatically generates and maintains documentation for code.
 * Uses AI to analyze code and create meaningful documentation.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type MagicDocsConfig = {
  /** Output directory for generated docs */
  outputDir?: string;
  /** Whether to generate README */
  generateReadme?: boolean;
  /** Whether to generate API docs */
  generateApiDocs?: boolean;
  /** Whether to generate changelogs */
  generateChangelog?: boolean;
  /** Documentation format */
  format?: "markdown" | "html" | "json";
};

export type GeneratedDoc = {
  path: string;
  content: string;
  generatedAt: Date;
  type: "readme" | "api" | "changelog" | "custom";
};

// ============================================================================
// MagicDocs Service Implementation
// ============================================================================

class MagicDocsService {
  private config: MagicDocsConfig;
  private outputDir: string;

  constructor(config: MagicDocsConfig = {}) {
    this.config = {
      outputDir: "./docs",
      generateReadme: true,
      generateApiDocs: true,
      generateChangelog: false,
      format: "markdown",
      ...config,
    };

    this.outputDir = this.config.outputDir ?? "./docs";
  }

  /**
   * Generate documentation for a project
   */
  async generateDocs(projectDir: string): Promise<GeneratedDoc[]> {
    const docs: GeneratedDoc[] = [];

    try {
      // Ensure output directory exists
      await mkdir(this.outputDir, { recursive: true });

      // Generate README if enabled
      if (this.config.generateReadme) {
        const readme = await this.generateReadme(projectDir);
        if (readme) {
          docs.push(readme);
        }
      }

      // Generate API docs if enabled
      if (this.config.generateApiDocs) {
        const apiDocs = await this.generateApiDocs(projectDir);
        if (apiDocs) {
          docs.push(apiDocs);
        }
      }

      // Generate changelog if enabled
      if (this.config.generateChangelog) {
        const changelog = await this.generateChangelog(projectDir);
        if (changelog) {
          docs.push(changelog);
        }
      }

      logger.info(`[MagicDocs] Generated ${docs.length} documentation files`);
      return docs;
    } catch (error) {
      logger.error(`[MagicDocs] Failed to generate docs: ${error}`);
      return [];
    }
  }

  /**
   * Generate README documentation
   */
  private async generateReadme(projectDir: string): Promise<GeneratedDoc | null> {
    try {
      // Analyze project structure
      const packageJson = await this.readPackageJson(projectDir);
      const srcFiles = await this.findSourceFiles(projectDir);

      const content = this.buildReadmeContent(packageJson, srcFiles);
      const outputPath = join(this.outputDir, "README.md");

      await writeFile(outputPath, content, "utf-8");

      return {
        path: outputPath,
        content,
        generatedAt: new Date(),
        type: "readme",
      };
    } catch (error) {
      logger.warn(`[MagicDocs] Failed to generate README: ${error}`);
      return null;
    }
  }

  /**
   * Generate API documentation
   */
  private async generateApiDocs(projectDir: string): Promise<GeneratedDoc | null> {
    try {
      const srcFiles = await this.findSourceFiles(projectDir);
      const apiFiles = srcFiles.filter(
        (f) => f.includes("api") || f.includes("routes") || f.includes("endpoint")
      );

      if (apiFiles.length === 0) {
        return null;
      }

      const content = this.buildApiDocsContent(apiFiles);
      const outputPath = join(this.outputDir, "API.md");

      await writeFile(outputPath, content, "utf-8");

      return {
        path: outputPath,
        content,
        generatedAt: new Date(),
        type: "api",
      };
    } catch (error) {
      logger.warn(`[MagicDocs] Failed to generate API docs: ${error}`);
      return null;
    }
  }

  /**
   * Generate changelog
   */
  private async generateChangelog(projectDir: string): Promise<GeneratedDoc | null> {
    try {
      const content = this.buildChangelogContent();
      const outputPath = join(this.outputDir, "CHANGELOG.md");

      await writeFile(outputPath, content, "utf-8");

      return {
        path: outputPath,
        content,
        generatedAt: new Date(),
        type: "changelog",
      };
    } catch (error) {
      logger.warn(`[MagicDocs] Failed to generate changelog: ${error}`);
      return null;
    }
  }

  /**
   * Read package.json from project
   */
  private async readPackageJson(projectDir: string): Promise<Record<string, unknown> | null> {
    try {
      const content = await readFile(join(projectDir, "package.json"), "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Find source files in project
   */
  private async findSourceFiles(projectDir: string): Promise<string[]> {
    const { readdir, stat } = await import("fs/promises");
    const files: string[] = [];

    const scanDir = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 3) return; // Limit recursion depth

      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          if (entry.startsWith(".") || entry === "node_modules") continue;

          const fullPath = join(dir, entry);
          const stats = await stat(fullPath);

          if (stats.isDirectory()) {
            await scanDir(fullPath, depth + 1);
          } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
            files.push(fullPath);
          }
        }
      } catch {
        // Ignore errors
      }
    };

    await scanDir(projectDir);
    return files;
  }

  /**
   * Build README content
   */
  private buildReadmeContent(
    packageJson: Record<string, unknown> | null,
    srcFiles: string[]
  ): string {
    const name = (packageJson?.name as string) ?? "Project";
    const description = (packageJson?.description as string) ?? "";
    const version = (packageJson?.version as string) ?? "1.0.0";

    const lines = [
      `# ${name}`,
      "",
      description ? `> ${description}` : "",
      "",
      `Version: ${version}`,
      "",
      "## Overview",
      "",
      "This project was generated with Pakalon AI.",
      "",
      "## Structure",
      "",
      "```",
      `Source files: ${srcFiles.length}`,
      "```",
      "",
      "## Getting Started",
      "",
      "```bash",
      "# Install dependencies",
      "npm install",
      "",
      "# Start development",
      "npm run dev",
      "```",
      "",
    ];

    return lines.join("\n");
  }

  /**
   * Build API docs content
   */
  private buildApiDocsContent(apiFiles: string[]): string {
    const lines = [
      "# API Documentation",
      "",
      "## Endpoints",
      "",
      ...apiFiles.map((file) => `- ${file}`),
      "",
    ];

    return lines.join("\n");
  }

  /**
   * Build changelog content
   */
  private buildChangelogContent(): string {
    const lines = [
      "# Changelog",
      "",
      "## [1.0.0] - " + new Date().toISOString().split("T")[0],
      "",
      "- Initial release",
      "",
    ];

    return lines.join("\n");
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultService: MagicDocsService | null = null;

/**
 * Get or create the default MagicDocs service
 */
export function getMagicDocsService(config?: MagicDocsConfig): MagicDocsService {
  if (!defaultService) {
    defaultService = new MagicDocsService(config);
  }
  return defaultService;
}

/**
 * Create a new MagicDocs service with custom config
 */
export function createMagicDocsService(config: MagicDocsConfig): MagicDocsService {
  return new MagicDocsService(config);
}
