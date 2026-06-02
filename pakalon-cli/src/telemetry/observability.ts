/**
 * Local Observability Dashboard
 *
 * Provides local telemetry collection and visualization
 * for monitoring agent performance and usage.
 */

import * as fs from 'fs';
import * as path from 'path';
import logger from '@/utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface TelemetryEvent {
  /** Event ID */
  id: string;
  /** Event type */
  type: string;
  /** Event timestamp */
  timestamp: Date;
  /** Event data */
  data: Record<string, unknown>;
  /** Duration in milliseconds (for performance events) */
  duration?: number;
  /** Success status */
  success: boolean;
  /** Error message (if failed) */
  error?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

export interface PerformanceMetrics {
  /** Total events recorded */
  totalEvents: number;
  /** Events by type */
  eventsByType: Record<string, number>;
  /** Success rate */
  successRate: number;
  /** Average duration by type */
  avgDurationByType: Record<string, number>;
  /** Error rate */
  errorRate: number;
  /** Events per time period */
  eventsPerHour: number;
  /** Memory usage */
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
}

export interface DashboardData {
  /** Metrics */
  metrics: PerformanceMetrics;
  /** Recent events */
  recentEvents: TelemetryEvent[];
  /** Active sessions */
  activeSessions: number;
  /** Uptime in seconds */
  uptime: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry Collector
// ─────────────────────────────────────────────────────────────────────────────

export class TelemetryCollector {
  private events: TelemetryEvent[] = [];
  private maxEvents: number;
  private sessionId: string;
  private startTime: Date;
  private dataDir: string;

  constructor(options?: { maxEvents?: number; dataDir?: string }) {
    this.maxEvents = options?.maxEvents || 1000;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.startTime = new Date();
    this.dataDir = options?.dataDir || path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.config',
      'pakalon',
      'telemetry'
    );
    
    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Record a telemetry event
   */
  record(type: string, data: Record<string, unknown>, options?: {
    duration?: number;
    success?: boolean;
    error?: string;
    metadata?: Record<string, unknown>;
  }): TelemetryEvent {
    const event: TelemetryEvent = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: new Date(),
      data,
      duration: options?.duration,
      success: options?.success ?? true,
      error: options?.error,
      metadata: {
        ...options?.metadata,
        sessionId: this.sessionId,
      },
    };

    this.events.push(event);

    // Trim old events if we exceed max
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    return event;
  }

  /**
   * Record a performance event with timing
   */
  async recordPerformance<T>(
    type: string,
    fn: () => Promise<T>,
    data?: Record<string, unknown>
  ): Promise<{ result: T; event: TelemetryEvent }> {
    const startTime = Date.now();
    let success = true;
    let error: string | undefined;
    let result: T;

    try {
      result = await fn();
    } catch (e) {
      success = false;
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      const duration = Date.now() - startTime;
      this.record(type, data || {}, { duration, success, error });
    }

    return { result: result!, event: this.events[this.events.length - 1]! };
  }

  /**
   * Get performance metrics
   */
  getMetrics(): PerformanceMetrics {
    const events = this.events;
    const totalEvents = events.length;
    
    // Events by type
    const eventsByType: Record<string, number> = {};
    for (const event of events) {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
    }

    // Success rate
    const successCount = events.filter((e) => e.success).length;
    const successRate = totalEvents > 0 ? successCount / totalEvents : 1;

    // Average duration by type
    const avgDurationByType: Record<string, number> = {};
    const durationSums: Record<string, number> = {};
    const durationCounts: Record<string, number> = {};
    
    for (const event of events) {
      if (event.duration !== undefined) {
        durationSums[event.type] = (durationSums[event.type] || 0) + event.duration;
        durationCounts[event.type] = (durationCounts[event.type] || 0) + 1;
      }
    }
    
    for (const type of Object.keys(durationSums)) {
      avgDurationByType[type] = durationSums[type]! / durationCounts[type]!;
    }

    // Error rate
    const errorRate = 1 - successRate;

    // Events per hour
    const hoursSinceStart = (Date.now() - this.startTime.getTime()) / (1000 * 60 * 60);
    const eventsPerHour = hoursSinceStart > 0 ? totalEvents / hoursSinceStart : 0;

    // Memory usage
    const memUsage = process.memoryUsage();

    return {
      totalEvents,
      eventsByType,
      successRate,
      avgDurationByType,
      errorRate,
      eventsPerHour,
      memoryUsage: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
      },
    };
  }

  /**
   * Get recent events
   */
  getRecentEvents(count: number = 10): TelemetryEvent[] {
    return this.events.slice(-count);
  }

  /**
   * Get dashboard data
   */
  getDashboardData(): DashboardData {
    return {
      metrics: this.getMetrics(),
      recentEvents: this.getRecentEvents(20),
      activeSessions: 1,
      uptime: (Date.now() - this.startTime.getTime()) / 1000,
    };
  }

  /**
   * Save telemetry data to disk
   */
  save(): void {
    try {
      const filePath = path.join(this.dataDir, `telemetry-${this.sessionId}.json`);
      const data = {
        sessionId: this.sessionId,
        startTime: this.startTime,
        events: this.events,
        metrics: this.getMetrics(),
      };
      
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      logger.info(`[Telemetry] Saved ${this.events.length} events to ${filePath}`);
    } catch (error) {
      logger.error(`[Telemetry] Failed to save: ${error}`);
    }
  }

  /**
   * Load telemetry data from disk
   */
  load(sessionId: string): boolean {
    try {
      const filePath = path.join(this.dataDir, `telemetry-${sessionId}.json`);
      if (!fs.existsSync(filePath)) {
        return false;
      }
      
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      this.sessionId = data.sessionId;
      this.startTime = new Date(data.startTime);
      this.events = data.events.map((e: any) => ({
        ...e,
        timestamp: new Date(e.timestamp),
      }));
      
      logger.info(`[Telemetry] Loaded ${this.events.length} events from ${filePath}`);
      return true;
    } catch (error) {
      logger.error(`[Telemetry] Failed to load: ${error}`);
      return false;
    }
  }

  /**
   * Generate ASCII dashboard
   */
  generateAsciiDashboard(): string {
    const metrics = this.getMetrics();
    const recentEvents = this.getRecentEvents(5);
    
    const lines: string[] = [];
    lines.push('╔══════════════════════════════════════════════════════════════╗');
    lines.push('║                    PAKALON OBSERVABILITY                    ║');
    lines.push('╠══════════════════════════════════════════════════════════════╣');
    lines.push(`║ Session: ${this.sessionId.substring(0, 50).padEnd(50)}║`);
    lines.push(`║ Uptime: ${this.formatDuration(metrics.totalEvents > 0 ? (Date.now() - this.startTime.getTime()) / 1000 : 0).padEnd(52)}║`);
    lines.push('╠══════════════════════════════════════════════════════════════╣');
    lines.push('║                      METRICS                                ║');
    lines.push(`║ Total Events: ${String(metrics.totalEvents).padEnd(46)}║`);
    lines.push(`║ Success Rate: ${(metrics.successRate * 100).toFixed(1).padEnd(46)}%║`);
    lines.push(`║ Error Rate: ${(metrics.errorRate * 100).toFixed(1).padEnd(48)}%║`);
    lines.push(`║ Events/Hour: ${metrics.eventsPerHour.toFixed(1).padEnd(47)}║`);
    lines.push('╠══════════════════════════════════════════════════════════════╣');
    lines.push('║                    EVENTS BY TYPE                           ║');
    
    for (const [type, count] of Object.entries(metrics.eventsByType).slice(0, 5)) {
      lines.push(`║ ${type.substring(0, 30).padEnd(30)} ${String(count).padStart(6).padEnd(24)}║`);
    }
    
    lines.push('╠══════════════════════════════════════════════════════════════╣');
    lines.push('║                    RECENT EVENTS                            ║');
    
    for (const event of recentEvents) {
      const time = event.timestamp.toLocaleTimeString();
      const status = event.success ? '✓' : '✗';
      lines.push(`║ ${status} ${time} ${event.type.substring(0, 40).padEnd(40)}║`);
    }
    
    lines.push('╚══════════════════════════════════════════════════════════════╝');
    
    return lines.join('\n');
  }

  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Instance
// ─────────────────────────────────────────────────────────────────────────────

export const telemetry = new TelemetryCollector();

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a telemetry event
 */
export function recordEvent(type: string, data: Record<string, unknown>, options?: {
  duration?: number;
  success?: boolean;
  error?: string;
}): TelemetryEvent {
  return telemetry.record(type, data, options);
}

/**
 * Record a performance event with timing
 */
export async function recordPerformance<T>(
  type: string,
  fn: () => Promise<T>,
  data?: Record<string, unknown>
): Promise<{ result: T; event: TelemetryEvent }> {
  return telemetry.recordPerformance(type, fn, data);
}

/**
 * Get dashboard data
 */
export function getDashboardData(): DashboardData {
  return telemetry.getDashboardData();
}

/**
 * Generate ASCII dashboard
 */
export function generateDashboard(): string {
  return telemetry.generateAsciiDashboard();
}
