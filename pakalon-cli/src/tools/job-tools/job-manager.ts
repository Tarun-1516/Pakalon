/**
 * Background Job Manager
 *
 * Manages long-running background tasks with status tracking,
 * cancellation support, and result retrieval.
 */

import logger from '@/utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job<T = unknown> {
  /** Unique job ID */
  id: string;
  /** Job name/description */
  name: string;
  /** Current status */
  status: JobStatus;
  /** Job result (when completed) */
  result?: T;
  /** Error message (when failed) */
  error?: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Progress message */
  progressMessage?: string;
  /** Creation timestamp */
  createdAt: Date;
  /** Start timestamp */
  startedAt?: Date;
  /** Completion timestamp */
  completedAt?: Date;
  /** Cancelled timestamp */
  cancelledAt?: Date;
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Abort controller for cancellation */
  abortController?: AbortController;
}

export interface JobCreateOptions<T = unknown> {
  /** Job name/description */
  name: string;
  /** Job function to execute */
  jobFn: (signal: AbortSignal, updateProgress: (progress: number, message?: string) => void) => Promise<T>;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Manager
// ─────────────────────────────────────────────────────────────────────────────

export class JobManager {
  private jobs: Map<string, Job> = new Map();
  private idCounter = 0;

  /**
   * Create and start a new job
   */
  async createJob<T = unknown>(options: JobCreateOptions<T>): Promise<Job<T>> {
    const id = `job-${Date.now()}-${++this.idCounter}`;
    const abortController = new AbortController();

    const job: Job<T> = {
      id,
      name: options.name,
      status: 'pending',
      progress: 0,
      createdAt: new Date(),
      metadata: options.metadata,
      abortController,
    };

    this.jobs.set(id, job as Job);

    // Start execution asynchronously
    this.executeJob(job as Job<T>, options.jobFn).catch((error) => {
      logger.error(`[JobManager] Job ${id} failed: ${error}`);
    });

    return job;
  }

  /**
   * Execute a job
   */
  private async executeJob<T>(
    job: Job<T>,
    jobFn: (signal: AbortSignal, updateProgress: (progress: number, message?: string) => void) => Promise<T>
  ): Promise<void> {
    job.status = 'running';
    job.startedAt = new Date();

    const updateProgress = (progress: number, message?: string) => {
      job.progress = Math.min(100, Math.max(0, progress));
      job.progressMessage = message;
    };

    try {
      const result = await jobFn(job.abortController!.signal, updateProgress);
      job.result = result;
      job.status = 'completed';
      job.progress = 100;
      job.completedAt = new Date();
      logger.info(`[JobManager] Job ${job.id} completed`);
    } catch (error) {
      if (job.status === 'cancelled') {
        job.cancelledAt = new Date();
        logger.info(`[JobManager] Job ${job.id} cancelled`);
      } else {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = 'failed';
        job.completedAt = new Date();
        logger.error(`[JobManager] Job ${job.id} failed: ${job.error}`);
      }
    } finally {
      delete job.abortController;
    }
  }

  /**
   * Get a job by ID
   */
  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /**
   * Get all jobs
   */
  getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get jobs by status
   */
  getJobsByStatus(status: JobStatus): Job[] {
    return this.getAllJobs().filter((job) => job.status === status);
  }

  /**
   * Cancel a job
   */
  cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.status === 'running' && job.abortController) {
      job.status = 'cancelled';
      job.abortController.abort();
      return true;
    }

    if (job.status === 'pending') {
      job.status = 'cancelled';
      job.cancelledAt = new Date();
      return true;
    }

    return false;
  }

  /**
   * Cancel all running jobs
   */
  cancelAllJobs(): number {
    let cancelled = 0;
    for (const job of this.getAllJobs()) {
      if (this.cancelJob(job.id)) {
        cancelled++;
      }
    }
    return cancelled;
  }

  /**
   * Remove a completed/failed/cancelled job
   */
  removeJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      this.jobs.delete(id);
      return true;
    }

    return false;
  }

  /**
   * Remove all completed/failed/cancelled jobs
   */
  cleanup(): number {
    let removed = 0;
    for (const job of this.getAllJobs()) {
      if (this.removeJob(job.id)) {
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get job summary
   */
  getSummary(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const jobs = this.getAllJobs();
    return {
      total: jobs.length,
      pending: jobs.filter((j) => j.status === 'pending').length,
      running: jobs.filter((j) => j.status === 'running').length,
      completed: jobs.filter((j) => j.status === 'completed').length,
      failed: jobs.filter((j) => j.status === 'failed').length,
      cancelled: jobs.filter((j) => j.status === 'cancelled').length,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Instance
// ─────────────────────────────────────────────────────────────────────────────

export const jobManager = new JobManager();

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create and start a new job
 */
export async function createJob<T = unknown>(options: JobCreateOptions<T>): Promise<Job<T>> {
  return jobManager.createJob(options);
}

/**
 * Get a job by ID
 */
export function getJob(id: string): Job | undefined {
  return jobManager.getJob(id);
}

/**
 * Get all jobs
 */
export function getAllJobs(): Job[] {
  return jobManager.getAllJobs();
}

/**
 * Cancel a job
 */
export function cancelJob(id: string): boolean {
  return jobManager.cancelJob(id);
}

/**
 * Get job summary
 */
export function getJobSummary() {
  return jobManager.getSummary();
}
