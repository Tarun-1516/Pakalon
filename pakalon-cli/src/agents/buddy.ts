/**
 * /buddy — spawn a "buddy" agent that helps out in the current session.
 *
 * Mirrors the reference CLI's "Buddy" feature. The buddy is a
 * background sub-agent that periodically reminds the user about
 * important state (failed tests, uncommitted changes, etc.).
 */
import { EventEmitter } from "events";
import { forkSubagent } from "@/agents/forkSubagent.js";
import logger from "@/utils/logger.js";

export interface BuddyOptions {
  projectDir: string;
  /** How often the buddy pings the user (ms). Default 60s. */
  intervalMs?: number;
  /** Disable the buddy. */
  silent?: boolean;
}

export class Buddy extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private opts: BuddyOptions;
  constructor(opts: BuddyOptions) {
    super();
    this.opts = { intervalMs: 60_000, silent: false, ...opts };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
    this.emit("started");
    logger.info({ intervalMs: this.opts.intervalMs }, "Buddy started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.emit("stopped");
    }
  }

  private async tick(): Promise<void> {
    try {
      const reminder = await forkSubagent({
        projectDir: this.opts.projectDir,
        prompt: "List any uncommitted files, failing tests, or pending PR comments.",
        silent: this.opts.silent,
      });
      if (reminder?.text) {
        this.emit("reminder", reminder.text);
        if (!this.opts.silent) {
          process.stdout.write(`\n[buddy] ${reminder.text}\n`);
        }
      }
    } catch (err) {
      logger.debug({ err }, "buddy tick failed");
    }
  }
}

export function startBuddy(opts: BuddyOptions): Buddy {
  const b = new Buddy(opts);
  b.start();
  return b;
}
