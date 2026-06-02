/**
 * /asciicast — record the terminal session as an .cast file.
 *
 * Wraps the headless terminal capture so the user can share a
 * reproducible replay of their build. Output is a JSON-lines file
 * compatible with asciinema (https://asciinema.org/docs/format).
 */
import * as fs from "fs/promises";
import * as path from "path";
import { EventEmitter } from "events";
import logger from "@/utils/logger.js";

export interface CastFrame {
  /** Monotonic time in seconds since the recording started */
  t: number;
  /** "o" = stdout, "e" = stderr, "i" = input */
  type: "o" | "e" | "i";
  /** Frame data */
  data: string;
}

export interface CastRecording {
  startedAt: number;
  frames: CastFrame[];
  emitter: EventEmitter;
  /** Width of the terminal in columns */
  width: number;
  /** Height in rows */
  height: number;
}

export class AsciicastRecorder {
  private rec: CastRecording;
  constructor(width = 120, height = 32) {
    this.rec = {
      startedAt: Date.now(),
      frames: [],
      emitter: new EventEmitter(),
      width,
      height,
    };
  }

  write(type: CastFrame["type"], data: string): void {
    const t = (Date.now() - this.rec.startedAt) / 1000;
    const frame: CastFrame = { t, type, data };
    this.rec.frames.push(frame);
    this.rec.emitter.emit("frame", frame);
  }

  out(data: string): void {
    this.write("o", data);
  }

  err(data: string): void {
    this.write("e", data);
  }

  in(data: string): void {
    this.write("i", data);
  }

  async save(outFile: string): Promise<string> {
    const header = {
      version: 2,
      width: this.rec.width,
      height: this.rec.height,
      timestamp: Math.floor(this.rec.startedAt / 1000),
      env: { TERM: process.env.TERM ?? "xterm-256color", SHELL: process.env.SHELL ?? "pakalon" },
    };
    const lines = [JSON.stringify(header), ...this.rec.frames.map((f) => JSON.stringify([f.t, f.type, f.data]))];
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, lines.join("\n") + "\n", "utf-8");
    logger.info({ outFile, frames: this.rec.frames.length }, "Asciicast saved");
    return outFile;
  }
}

export async function startRecording(outFile: string, width = 120, height = 32): Promise<AsciicastRecorder> {
  const rec = new AsciicastRecorder(width, height);
  rec.out("Pakalon session recording started.\r\n");
  // Auto-save on process exit
  const handler = async () => {
    try {
      await rec.save(outFile);
    } catch (err) {
      logger.warn({ err }, "asciicast auto-save failed");
    }
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  process.once("exit", handler);
  return rec;
}
