/**
 * Plugins Service for pakalon-cli
 *
 * Manages plugin installation, activation, and lifecycle.
 */

import { readFile, writeFile, mkdir, readdir, rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type PluginConfig = {
  /** Plugin name */
  name: string;
  /** Plugin version */
  version: string;
  /** Plugin description */
  description?: string;
  /** Plugin entry point */
  entry?: string;
  /** Plugin dependencies */
  dependencies?: string[];
  /** Whether plugin is enabled */
  enabled?: boolean;
};

export type InstalledPlugin = PluginConfig & {
  installedAt: Date;
  enabled: boolean;
};

// ============================================================================
// Plugins Service Implementation
// ============================================================================

class PluginsService {
  private pluginsDir: string;
  private plugins: Map<string, InstalledPlugin> = new Map();

  constructor() {
    this.pluginsDir = join(homedir(), ".config", "pakalon", "plugins");
  }

  /**
   * Initialize plugins service
   */
  async initialize(): Promise<void> {
    try {
      await mkdir(this.pluginsDir, { recursive: true });
      await this.loadInstalledPlugins();
      logger.info(`[PluginsService] Initialized with ${this.plugins.size} plugins`);
    } catch (error) {
      logger.error(`[PluginsService] Failed to initialize: ${error}`);
    }
  }

  /**
   * Load installed plugins from disk
   */
  private async loadInstalledPlugins(): Promise<void> {
    try {
      const entries = await readdir(this.pluginsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;

        const pluginPath = join(this.pluginsDir, entry);
        const content = await readFile(pluginPath, "utf-8");
        const config = JSON.parse(content) as InstalledPlugin;

        this.plugins.set(config.name, {
          ...config,
          installedAt: new Date(config.installedAt),
        });
      }
    } catch (error) {
      logger.warn(`[PluginsService] Failed to load plugins: ${error}`);
    }
  }

  /**
   * Install a plugin
   */
  async install(pluginConfig: PluginConfig): Promise<boolean> {
    try {
      const plugin: InstalledPlugin = {
        ...pluginConfig,
        enabled: pluginConfig.enabled ?? true,
        installedAt: new Date(),
      };

      // Save plugin config
      const configPath = join(this.pluginsDir, `${plugin.name}.json`);
      await writeFile(configPath, JSON.stringify(plugin, null, 2), "utf-8");

      this.plugins.set(plugin.name, plugin);
      logger.info(`[PluginsService] Installed plugin: ${plugin.name}`);
      return true;
    } catch (error) {
      logger.error(`[PluginsService] Failed to install plugin: ${error}`);
      return false;
    }
  }

  /**
   * Uninstall a plugin
   */
  async uninstall(pluginName: string): Promise<boolean> {
    try {
      const configPath = join(this.pluginsDir, `${pluginName}.json`);
      await rm(configPath, { force: true });

      this.plugins.delete(pluginName);
      logger.info(`[PluginsService] Uninstalled plugin: ${pluginName}`);
      return true;
    } catch (error) {
      logger.error(`[PluginsService] Failed to uninstall plugin: ${error}`);
      return false;
    }
  }

  /**
   * Enable a plugin
   */
  async enable(pluginName: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      return false;
    }

    plugin.enabled = true;
    await this.savePlugin(plugin);
    logger.info(`[PluginsService] Enabled plugin: ${pluginName}`);
    return true;
  }

  /**
   * Disable a plugin
   */
  async disable(pluginName: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      return false;
    }

    plugin.enabled = false;
    await this.savePlugin(plugin);
    logger.info(`[PluginsService] Disabled plugin: ${pluginName}`);
    return true;
  }

  /**
   * Save plugin config to disk
   */
  private async savePlugin(plugin: InstalledPlugin): Promise<void> {
    const configPath = join(this.pluginsDir, `${plugin.name}.json`);
    await writeFile(configPath, JSON.stringify(plugin, null, 2), "utf-8");
  }

  /**
   * List installed plugins
   */
  listPlugins(): InstalledPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugin info
   */
  getPlugin(pluginName: string): InstalledPlugin | undefined {
    return this.plugins.get(pluginName);
  }

  /**
   * Check if plugin is installed
   */
  isInstalled(pluginName: string): boolean {
    return this.plugins.has(pluginName);
  }

  /**
   * Check if plugin is enabled
   */
  isEnabled(pluginName: string): boolean {
    const plugin = this.plugins.get(pluginName);
    return plugin?.enabled ?? false;
  }

  /**
   * Get enabled plugins
   */
  getEnabledPlugins(): InstalledPlugin[] {
    return this.listPlugins().filter((p) => p.enabled);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let defaultService: PluginsService | null = null;

/**
 * Get or create the default Plugins service
 */
export function getPluginsService(): PluginsService {
  if (!defaultService) {
    defaultService = new PluginsService();
  }
  return defaultService;
}

/**
 * Create a new Plugins service
 */
export function createPluginsService(): PluginsService {
  return new PluginsService();
}
