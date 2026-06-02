/**
 * Docker execution helpers for SAST tools.
 *
 * Attempts to run via Docker; falls back to native binaries with a warning
 * when Docker is unavailable.
 */

import { spawn } from 'child_process';
import logger from '@/utils/logger.js';

const DOCKER_NOT_FOUND_MESSAGES = [
  'not recognized',
  'command not found',
  'ENOENT',
];

export interface DockerRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * Check whether Docker is available on this host.
 */
let dockerAvailable: boolean | null = null;

export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;

  try {
    const result = await execCommand('docker info', 10_000);
    dockerAvailable = result.exitCode === 0;
  } catch {
    dockerAvailable = false;
  }

  if (!dockerAvailable) {
    logger.warn('[sast-runner] Docker is not available — SAST tools will attempt native fallback');
  }

  return dockerAvailable;
}

/**
 * Run a command string via the shell, returning stdout/stderr/exitCode.
 */
export function execCommand(command: string, timeoutMs = 120_000): Promise<DockerRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      timeout: timeoutMs,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
      });
    });

    child.on('error', (err) => {
      const message = String(err.message ?? err);
      if (DOCKER_NOT_FOUND_MESSAGES.some((m) => message.includes(m))) {
        resolve({ stdout: '', stderr: message, exitCode: -1, timedOut: false });
        return;
      }
      resolve({ stdout, stderr: message, exitCode: 1, timedOut: false });
    });

    if ('kill' in child) {
      const originalTimeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.on('close', () => clearTimeout(originalTimeout));
    }
  });
}

/**
 * Execute a SAST tool via Docker, mounting the target path as /src.
 *
 * If Docker is unavailable, the caller should handle a native fallback.
 * Returns the raw stdout that the container produced.
 */
export async function runInDocker(opts: {
  image: string;
  targetPath: string;
  command: string;
  extraArgs?: string[];
  timeoutMs?: number;
}): Promise<DockerRunResult> {
  const { image, targetPath, command, extraArgs = [], timeoutMs = 120_000 } = opts;

  const dockerArgs = [
    'docker run --rm',
    `-v "${targetPath}:/src"`,
    '-w /src',
    ...extraArgs,
    image,
    command,
  ].join(' ');

  const result = await execCommand(dockerArgs, timeoutMs);

  if (result.exitCode === -1) {
    logger.warn(`[sast-runner] Docker unavailable for ${image}`);
  } else if (result.exitCode !== 0) {
    logger.warn(`[sast-runner] Docker run for ${image} exited with code ${result.exitCode}`);
    if (result.stderr) {
      logger.warn(`[sast-runner] stderr: ${result.stderr.slice(0, 500)}`);
    }
  }

  return result;
}
