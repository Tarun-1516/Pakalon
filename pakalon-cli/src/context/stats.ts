/**
 * /stats — display quick aggregate statistics.
 *
 * Aggregates session count, total tokens, total cost, and a histogram
 * of model usage. Pulls from `.pakalon/history/*.json` (see
 * token-usage-history.ts).
 */
import { listSessionUsage, renderUsageTable } from "@/context/token-usage-history.js";
import logger from "@/utils/logger.js";

export interface StatsSummary {
  sessionCount: number;
  totalTokens: number;
  totalCostUsd: number;
  byModel: Record<string, number>;
}

export async function computeStats(projectDir: string): Promise<StatsSummary> {
  const rows = await listSessionUsage(projectDir, 1000);
  const byModel: Record<string, number> = {};
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const r of rows) {
    totalTokens += r.totalTokens;
    totalCostUsd += r.costUsd;
    byModel[r.model] = (byModel[r.model] ?? 0) + r.totalTokens;
  }
  return { sessionCount: rows.length, totalTokens, totalCostUsd, byModel };
}

export async function renderStats(projectDir: string): Promise<string> {
  try {
    const stats = await computeStats(projectDir);
    const rows = await listSessionUsage(projectDir, 20);
    const modelList = Object.entries(stats.byModel)
      .sort((a, b) => b[1] - a[1])
      .map(([m, t]) => `- **${m}**: ${t.toLocaleString()} tokens`)
      .join("\n");
    return [
      "# Pakalon session stats",
      "",
      `- Sessions: **${stats.sessionCount}**`,
      `- Total tokens: **${stats.totalTokens.toLocaleString()}**`,
      `- Total cost: **$${stats.totalCostUsd.toFixed(4)}**`,
      "",
      "## By model",
      modelList || "_none_",
      "",
      "## Last 20 sessions",
      "",
      renderUsageTable(rows),
    ].join("\n");
  } catch (err) {
    logger.warn({ err }, "renderStats failed");
    return "# Pakalon session stats\n\n_Unable to load history._";
  }
}
