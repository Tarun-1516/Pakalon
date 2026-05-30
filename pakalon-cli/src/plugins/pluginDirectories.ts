/**
 * Plugin Directories
 *
 * Discovers and scans plugin directories for available plugins.
 */

import * as fs from 'fs';
import * as path from 'path';
import logger from '@/utils/logger.js';

/**
 * Discovered plugin.
 */
export interface DiscoveredPlugin {
  name: string;
  path: string;
  version: string;
  hasEntry: boolean;
  entryFile?: string;
  description?: string;
}

/**
 * Get default plugin search paths.
 */
export function getDefaultPluginPaths(): string[] {
  const paths: string[] = [];

  // User config directory
  const configHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (configHome) {
    paths.push(path.join(configHome, '.config', 'pakalon', 'plugins'));
  }

  // Project-local plugins
  paths.push(path.join(process.cwd(), '.pakalon', 'plugins'));

  // Node modules with pakalon-plugin keyword
  paths.push(path.join(process.cwd(), 'node_modules'));

  return paths;
}

/**
 * Discover plugins in search paths.
 */
export function discoverPlugins(searchPaths?: string[]): DiscoveredPlugin[] {
  const paths = searchPaths ?? getDefaultPluginPaths();
  const plugins: DiscoveredPlugin[] = [];

  for (const searchPath of paths) {
    try {
      const found = scanPluginDir(searchPath);
      plugins.push(...found);
    } catch (err) {
      logger.debug('[PluginDirectories] Failed to scan', { path: searchPath, error: String(err) });
    }
  }

  // Deduplicate by name
  const seen = new Set<string>();
  return plugins.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

/**
 * Scan a directory for plugins.
 */
export function scanPluginDir(dir: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];

  if (!fs.existsSync(dir)) return plugins;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = path.join(dir, entry.name);
    const plugin = scanSinglePlugin(pluginDir, entry.name);
    if (plugin) {
      plugins.push(plugin);
    }
  }

  return plugins;
}

/**
 * Scan a single plugin directory.
 */
function scanSinglePlugin(pluginDir: string, fallbackName: string): DiscoveredPlugin | null {
  try {
    // Check for package.json
    const packageJsonPath = path.join(pluginDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // Check if it's a pakalon plugin
      const isPlugin =
        packageJson.keywords?.includes('pakalon-plugin') ||
        packageJson.pakalon ||
        packageJson.main;

      if (!isPlugin) return null;

      const name = packageJson.name ?? fallbackName;
      const version = packageJson.version ?? '0.0.0';
      const description = packageJson.description;

      // Find entry file
      const entryCandidates = [
        packageJson.main,
        packageJson.pakalon?.entry,
        'index.js',
        'index.ts',
        'dist/index.js',
      ].filter(Boolean);

      const entryFile = entryCandidates.find((candidate) =>
        fs.existsSync(path.join(pluginDir, candidate!)),
      );

      return {
        name,
        path: pluginDir,
        version,
        hasEntry: !!entryFile,
        entryFile: entryFile ? path.join(pluginDir, entryFile) : undefined,
        description,
      };
    }

    // Check for bare JS/TS files
    const indexCandidates = ['index.js', 'index.ts', 'main.js', 'main.ts'];
    for (const candidate of indexCandidates) {
      const candidatePath = path.join(pluginDir, candidate);
      if (fs.existsSync(candidatePath)) {
        return {
          name: fallbackName,
          path: pluginDir,
          version: '0.0.0',
          hasEntry: true,
          entryFile: candidatePath,
        };
      }
    }
  } catch (err) {
    logger.debug('[PluginDirectories] Failed to scan plugin', { dir: pluginDir, error: String(err) });
  }

  return null;
}
