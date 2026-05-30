/**
 * Plugin Telemetry
 *
 * Tracks plugin loading, errors, and usage for analytics.
 */

import * as fs from 'fs';
import * as path from 'path';
import logger from '@/utils/logger.js';

/**
 * Plugin telemetry statistics.
 */
export interface PluginTelemetryStats {
  loads: number;
  errors: number;
  usage: Record<string, number>;
}

/**
 * Tracks plugin telemetry data.
 */
export class PluginTelemetry {
  private loads = 0;
  private errors = 0;
  private usage = new Map<string, number>();
  private projectDir: string;

  constructor(projectDir?: string) {
    this.projectDir = projectDir ?? process.cwd();
    this.load();
  }

  /**
   * Track a plugin load event.
   */
  trackPluginLoad(pluginName: string, duration: number): void {
    this.loads++;
    const key = `${pluginName}:load`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
    this.save();

    logger.debug('[PluginTelemetry] Plugin loaded', { pluginName, duration });
  }

  /**
   * Track a plugin error.
   */
  trackPluginError(pluginName: string, error: Error): void {
    this.errors++;
    const key = `${pluginName}:error`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
    this.save();

    logger.warn('[PluginTelemetry] Plugin error', { pluginName, error: error.message });
  }

  /**
   * Track a plugin usage event.
   */
  trackPluginUsage(pluginName: string, action: string): void {
    const key = `${pluginName}:${action}`;
    this.usage.set(key, (this.usage.get(key) ?? 0) + 1);
    this.save();
  }

  /**
   * Get telemetry statistics.
   */
  getStats(): PluginTelemetryStats {
    const usageObj: Record<string, number> = {};
    for (const [key, value] of this.usage) {
      usageObj[key] = value;
    }

    return {
      loads: this.loads,
      errors: this.errors,
      usage: usageObj,
    };
  }

  /**
   * Reset telemetry data.
   */
  reset(): void {
    this.loads = 0;
    this.errors = 0;
    this.usage.clear();
    this.save();
  }

  // ── Persistence ──

  private getFilePath(): string {
    return path.join(this.projectDir, '.pakalon', 'plugin-telemetry.json');
  }

  private load(): void {
    try {
      const filePath = this.getFilePath();
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        this.loads = data.loads ?? 0;
        this.errors = data.errors ?? 0;
        if (data.usage && typeof data.usage === 'object') {
          for (const [key, value] of Object.entries(data.usage)) {
            this.usage.set(key, value as number);
          }
        }
      }
    } catch {
      // Start fresh
    }
  }

  private save(): void {
    try {
      const dir = path.join(this.projectDir, '.pakalon');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        loads: this.loads,
        errors: this.errors,
        usage: Object.fromEntries(this.usage),
      };

      fs.writeFileSync(this.getFilePath(), JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.warn('[PluginTelemetry] Failed to save', { error: String(err) });
    }
  }
}

// Singleton instance
let _instance: PluginTelemetry | null = null;

/**
 * Get the global plugin telemetry instance.
 */
export function getPluginTelemetry(projectDir?: string): PluginTelemetry {
  if (!_instance) {
    _instance = new PluginTelemetry(projectDir);
  }
  return _instance;
}
