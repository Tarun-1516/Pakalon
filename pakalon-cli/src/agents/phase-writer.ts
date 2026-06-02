/**
 * Generic per-phase writer.
 *
 * After each phase completes, call writePhase() to drop a
 * `phase-N.md` summary in `.pakalon-agents/ai-agents/phase-N/`. The
 * writer also appends a row to a global `phases-index.json` so
 * subsequent phases can find context quickly.
 */
import * as fs from "fs";
import * as path from "path";
import logger from "@/utils/logger.js";

export interface PhaseSummarySection {
  heading: string;
  body: string;
}

export interface PhaseSummary {
  phase: number;
  name: string;
  status: "success" | "partial" | "failed";
  sections: PhaseSummarySection[];
  metadata?: Record<string, unknown>;
}

const PHASES_DIR = "phase";
const INDEX_FILE = "phases-index.json";

/** Write a single phase-N.md to disk and update the global index. */
export async function writePhase(projectDir: string, summary: PhaseSummary): Promise<string> {
  if (!projectDir) throw new Error("writePhase: projectDir is required");
  if (typeof summary.phase !== "number" || summary.phase < 1 || summary.phase > 6) {
    throw new Error(`writePhase: phase must be between 1 and 6 (got ${summary.phase})`);
  }

  const dir = path.join(projectDir, ".pakalon-agents", "ai-agents", `${PHASES_DIR}-${summary.phase}`);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, "phase-summary.md");

  const md = renderMarkdown(summary);
  await fs.promises.writeFile(file, md, "utf-8");

  await updateIndex(projectDir, summary, file);
  logger.info({ phase: summary.phase, status: summary.status, file }, "Phase summary written");
  return file;
}

function renderMarkdown(summary: PhaseSummary): string {
  const ts = new Date().toISOString();
  const sections = summary.sections
    .map((s) => `## ${s.heading}\n\n${s.body.trim()}\n`)
    .join("\n");
  const meta = summary.metadata
    ? `\n## Metadata\n\n\`\`\`json\n${JSON.stringify(summary.metadata, null, 2)}\n\`\`\`\n`
    : "";
  return `# Phase ${summary.phase}: ${summary.name}\n\n**Status:** ${summary.status}  \n**Generated:** ${ts}\n\n${sections}${meta}\n`;
}

async function updateIndex(
  projectDir: string,
  summary: PhaseSummary,
  file: string,
): Promise<void> {
  const root = path.join(projectDir, ".pakalon-agents", "ai-agents");
  const indexPath = path.join(root, INDEX_FILE);
  let index: { phases: Array<{ phase: number; name: string; status: string; file: string; ts: string }> } = { phases: [] };
  try {
    const raw = await fs.promises.readFile(indexPath, "utf-8");
    index = JSON.parse(raw);
  } catch {
    // fresh index
  }
  // Replace any prior entry for this phase
  index.phases = index.phases.filter((p) => p.phase !== summary.phase);
  index.phases.push({
    phase: summary.phase,
    name: summary.name,
    status: summary.status,
    file,
    ts: new Date().toISOString(),
  });
  index.phases.sort((a, b) => a.phase - b.phase);
  await fs.promises.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

/** Read all phase summaries back. */
export async function readAllPhases(projectDir: string): Promise<PhaseSummary[]> {
  const root = path.join(projectDir, ".pakalon-agents", "ai-agents");
  const indexPath = path.join(root, INDEX_FILE);
  try {
    const raw = await fs.promises.readFile(indexPath, "utf-8");
    const { phases } = JSON.parse(raw) as { phases: Array<{ file: string; phase: number }> };
    const out: PhaseSummary[] = [];
    for (const entry of phases) {
      try {
        const md = await fs.promises.readFile(entry.file, "utf-8");
        out.push({ phase: entry.phase, name: extractHeading(md), status: "success", sections: [], metadata: { raw: md } });
      } catch {
        // skip missing
      }
    }
    return out.sort((a, b) => a.phase - b.phase);
  } catch {
    return [];
  }
}

function extractHeading(md: string): string {
  const m = md.match(/^#\s+Phase\s+\d+:\s*(.+)$/m);
  return m ? m[1].trim() : "unknown";
}
