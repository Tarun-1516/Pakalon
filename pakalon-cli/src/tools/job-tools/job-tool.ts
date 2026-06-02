/**
 * Job Tool
 *
 * Provides tools for managing background jobs from the agent.
 */

import { z } from 'zod';
import { createJob, getJob, getAllJobs, cancelJob, getJobSummary, jobManager } from './job-manager.js';
import logger from '@/utils/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Job Create Tool
// ─────────────────────────────────────────────────────────────────────────────

export const jobCreateToolSchema = z.object({
  name: z.string().describe('Job name/description'),
  type: z.enum(['shell', 'fetch', 'process']).describe('Job type'),
  command: z.string().optional().describe('Shell command to execute (for shell type)'),
  url: z.string().optional().describe('URL to fetch (for fetch type)'),
  timeout: z.number().optional().describe('Timeout in milliseconds'),
});

export const jobCreateTool = {
  name: 'job_create',
  description: 'Create a background job for long-running tasks',
  parameters: jobCreateToolSchema,
  
  async execute({ name, type, command, url, timeout = 300000 }: z.infer<typeof jobCreateToolSchema>) {
    try {
      const job = await createJob({
        name,
        metadata: { type, command, url, timeout },
        jobFn: async (signal, updateProgress) => {
          updateProgress(0, 'Starting...');
          
          switch (type) {
            case 'fetch': {
              if (!url) throw new Error('URL required for fetch job');
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), timeout);
              
              signal.addEventListener('abort', () => controller.abort());
              
              try {
                const response = await fetch(url, { signal: controller.signal });
                const text = await response.text();
                clearTimeout(timeoutId);
                return { status: response.status, body: text };
              } catch (error) {
                clearTimeout(timeoutId);
                throw error;
              }
            }
            
            case 'bash': {
              if (!command) throw new Error('Command required for bash job');
              const { execSync } = await import('child_process');
              
              return new Promise((resolve, reject) => {
                const process = execSync(command, {
                  signal: signal as any,
                  timeout,
                  encoding: 'utf-8',
                });
                resolve({ output: process });
              });
            }
            
            default:
              throw new Error(`Unknown job type: ${type}`);
          }
        },
      });
      
      return {
        success: true,
        jobId: job.id,
        message: `Created job ${job.id}: ${name}`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create job: ${message}`);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Job Status Tool
// ─────────────────────────────────────────────────────────────────────────────

export const jobStatusToolSchema = z.object({
  jobId: z.string().optional().describe('Job ID to check (optional, lists all if omitted)'),
});

export const jobStatusTool = {
  name: 'job_status',
  description: 'Get status of background jobs',
  parameters: jobStatusToolSchema,
  
  async execute({ jobId }: z.infer<typeof jobStatusToolSchema>) {
    if (jobId) {
      const job = getJob(jobId);
      if (!job) {
        return { success: false, message: `Job ${jobId} not found` };
      }
      
      return {
        success: true,
        job: {
          id: job.id,
          name: job.name,
          status: job.status,
          progress: job.progress,
          progressMessage: job.progressMessage,
          result: job.result,
          error: job.error,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        }
      };
    }
    
    const summary = getJobSummary();
    const jobs = getAllJobs().map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      progress: job.progress,
    }));
    
    return {
      success: true,
      summary,
      jobs
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Job Cancel Tool
// ─────────────────────────────────────────────────────────────────────────────

export const jobCancelToolSchema = z.object({
  jobId: z.string().describe('Job ID to cancel'),
});

export const jobCancelTool = {
  name: 'job_cancel',
  description: 'Cancel a running background job',
  parameters: jobCancelToolSchema,
  
  async execute({ jobId }: z.infer<typeof jobCancelToolSchema>) {
    const success = cancelJob(jobId);
    
    if (success) {
      return { success: true, message: `Cancelled job ${jobId}` };
    } else {
      return { success: false, message: `Failed to cancel job ${jobId} (not found or not cancellable)` };
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Job Cleanup Tool
// ─────────────────────────────────────────────────────────────────────────────

export const jobCleanupTool = {
  name: 'job_cleanup',
  description: 'Remove completed/failed/cancelled jobs',
  parameters: z.object({}),
  
  async execute() {
    const removed = jobManager.cleanup();
    const summary = getJobSummary();
    
    return {
      success: true,
      removed,
      summary
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Export all tools
// ─────────────────────────────────────────────────────────────────────────────

export const jobTools = {
  job_create: jobCreateTool,
  job_status: jobStatusTool,
  job_cancel: jobCancelTool,
  job_cleanup: jobCleanupTool,
};
