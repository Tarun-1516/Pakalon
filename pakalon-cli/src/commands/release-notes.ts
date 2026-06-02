/**
 * /release-notes — show the changelog since the last CLI update.
 *
 * Wraps the existing CHANGELOG.md reader. Useful after `pakalon update`.
 */
import * as fs from "fs/promises";
import * as path from "path";
import logger from "@/utils/logger.js";

export async function getReleaseNotes(projectDir: string, sinceTag?: string): Promise<string> {
  const file = path.join(projectDir, "CHANGELOG.md");
  try {
    const text = await fs.readFile(file, "utf-8");
    if (!sinceTag) return text;
    // crude section cut: keep everything from the first "## [" after sinceTag
    const idx = text.indexOf(sinceTag);
    return idx > 0 ? text.slice(idx) : text;
  } catch (err) {
    logger.warn({ err }, "CHANGELOG.md missing; returning default notes");
    return "# Release notes\n\nNo CHANGELOG.md found in the project root.";
  }
}
