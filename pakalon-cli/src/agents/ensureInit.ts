/**
 * Pakalon Agents auto-init helper.
 *
 * The 6-phase agentic pipeline writes its planning documents, wireframe
 * outputs, build logs, and deployment artifacts into a project-local
 * `.pakalon-agents/` directory. Historically the user had to run `/pakalon`
 * (or `cmdPakalonAgents`) up front to scaffold that directory, otherwise the
 * phases would either write into a bare directory or fail in subtle ways.
 *
 * `ensurePakalonAgentsDir` removes that friction: if `.pakalon-agents/` is
 * missing when a phase run starts, the helper transparently creates a minimal
 * scaffold (settings.json + `agents/` directory) so the phases can proceed.
 * The explicit `/pakalon-agents` command still works as before and produces
 * the full planning-document scaffold — this helper is the lazy, lighter
 * fallback for first-time users.
 */
import * as path from "path";
import * as fs from "fs/promises";
import logger from "@/utils/logger.js";

export const PAKALON_AGENTS_DIR_NAME = ".pakalon-agents";

export interface EnsurePakalonAgentsDirResult {
  /** Absolute path to the `.pakalon-agents/` directory. */
  path: string;
  /** True when the helper had to create the directory on disk. */
  initialized: boolean;
  /** True when the directory already existed on entry. */
  alreadyExisted: boolean;
  /** Scaffold files that were created (relative to the agents dir). */
  createdFiles: string[];
  /** Subdirectories that were created (relative to the agents dir). */
  createdDirs: string[];
}

const DEFAULT_SETTINGS_JSON: Readonly<Record<string, unknown>> = Object.freeze({
  version: 1,
  mode: "hil",
  privacyMode: false,
  autoInitialized: true,
  initializedAt: new Date(0).toISOString(),
});

/**
 * Build the absolute path to `.pakalon-agents/` inside a project root.
 */
export function getPakalonAgentsDir(projectRoot: string): string {
  return path.join(projectRoot, PAKALON_AGENTS_DIR_NAME);
}

/**
 * Ensure that `.pakalon-agents/` exists for the given project root.
 *
 * If the directory is missing, this helper creates a minimal scaffold:
 *   - `.pakalon-agents/settings.json` — runtime defaults
 *   - `.pakalon-agents/agents/.gitkeep` — agents subdirectory tracked by git
 *   - `.pakalon-agents/README.md` — short pointer to `/pakalon-agents` for
 *     users who want the full scaffold
 *
 * The function never throws on an already-initialized directory: it returns
 * the existing path with `initialized: false`.
 *
 * On first-time initialization, an informational message is logged via the
 * project's logger so the user knows what happened.
 */
export async function ensurePakalonAgentsDir(
  projectRoot: string,
): Promise<EnsurePakalonAgentsDirResult> {
  const agentsDir = getPakalonAgentsDir(projectRoot);
  const createdFiles: string[] = [];
  const createdDirs: string[] = [];

  let alreadyExisted = true;
  try {
    const stat = await fs.stat(agentsDir);
    if (!stat.isDirectory()) {
      throw new Error(
        `${agentsDir} exists but is not a directory; refusing to overwrite`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      alreadyExisted = false;
    } else {
      throw error;
    }
  }

  if (alreadyExisted) {
    return {
      path: agentsDir,
      initialized: false,
      alreadyExisted: true,
      createdFiles,
      createdDirs,
    };
  }

  await fs.mkdir(agentsDir, { recursive: true });
  createdDirs.push(PAKALON_AGENTS_DIR_NAME);

  const agentsSubdir = path.join(agentsDir, "agents");
  await fs.mkdir(agentsSubdir, { recursive: true });
  createdDirs.push(path.join(PAKALON_AGENTS_DIR_NAME, "agents"));

  const gitkeepPath = path.join(agentsSubdir, ".gitkeep");
  await fs.writeFile(gitkeepPath, "", "utf-8");
  createdFiles.push(path.join(PAKALON_AGENTS_DIR_NAME, "agents", ".gitkeep"));

  const settingsPath = path.join(agentsDir, "settings.json");
  const settingsPayload = {
    ...DEFAULT_SETTINGS_JSON,
    initializedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    settingsPath,
    `${JSON.stringify(settingsPayload, null, 2)}\n`,
    "utf-8",
  );
  createdFiles.push(path.join(PAKALON_AGENTS_DIR_NAME, "settings.json"));

  const readmePath = path.join(agentsDir, "README.md");
  const readmeContent =
    `# ${PAKALON_AGENTS_DIR_NAME}\n\n` +
    `This directory was auto-initialized by Pakalon so the 6-phase agentic\n` +
    `pipeline can run without a prior \`/pakalon-agents\` invocation.\n\n` +
    `For the full planning-document scaffold (plan.md, tasks.md, prd.md,\n` +
    `wireframes, sub-agent logs, etc.), run \`/pakalon-agents\` explicitly.\n`;
  await fs.writeFile(readmePath, readmeContent, "utf-8");
  createdFiles.push(path.join(PAKALON_AGENTS_DIR_NAME, "README.md"));

  logger.info(
    `[Init] Initializing ${PAKALON_AGENTS_DIR_NAME}/ (first run) — created ${createdFiles.length} file(s) and ${createdDirs.length} dir(s) at ${agentsDir}`,
  );

  return {
    path: agentsDir,
    initialized: true,
    alreadyExisted: false,
    createdFiles,
    createdDirs,
  };
}

export default ensurePakalonAgentsDir;
