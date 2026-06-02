/**
 * /connect-end — cleanly disconnect a previously-linked Telegram bot.
 *
 * CLI-req §"/connect" and §"telegram bridge" specify that the user
 * should be able to:
 *   1. Connect a bot (handled by `connect.ts`).
 *   2. Disconnect it (this command).
 *
 * The disconnect flow:
 *   - Asks the backend to remove the stored webhook + token.
 *   - Deletes the local state file at ~/.config/pakalon/telegram.json.
 *   - Prints a confirmation.
 */
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import logger from "@/utils/logger.js";

const STATE_FILE = path.join(os.homedir(), ".config", "pakalon", "telegram.json");

interface TelegramState {
  botToken?: string;
  chatId?: string;
  webhookUrl?: string;
  linkedAt?: string;
}

export interface ConnectEndOptions {
  /** Force disconnect even if the local state file is missing. */
  force?: boolean;
  /** Skip backend call (useful in offline / self-hosted mode). */
  skipBackend?: boolean;
  /** Override the backend URL. */
  backendUrl?: string;
  /** Path to the state file (mostly for tests). */
  stateFile?: string;
}

export async function connectEnd(opts: ConnectEndOptions = {}): Promise<{ ok: boolean; stateFile: string; backendRemoved: boolean; reason: string }> {
  const stateFile = opts.stateFile ?? STATE_FILE;
  let state: TelegramState = {};
  let hadState = false;
  try {
    const raw = await fs.readFile(stateFile, "utf-8");
    state = JSON.parse(raw);
    hadState = true;
  } catch {
    if (!opts.force) {
      return { ok: false, stateFile, backendRemoved: false, reason: "no_state" };
    }
  }

  let backendRemoved = false;
  if (!opts.skipBackend && state.botToken) {
    const url = `${opts.backendUrl ?? process.env.PAKALON_BACKEND_URL ?? "https://api.pakalon.com"}/api/telegram/disconnect`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.PAKALON_TOKEN ?? ""}` },
        body: JSON.stringify({ bot_token: state.botToken }),
      });
      backendRemoved = res.ok;
      if (!res.ok) logger.warn({ status: res.status }, "Backend telegram/disconnect returned non-OK");
    } catch (err) {
      logger.warn({ err }, "Backend telegram/disconnect request failed (continuing with local cleanup)");
    }
  }

  try {
    await fs.unlink(stateFile);
  } catch {
    // best effort
  }

  return {
    ok: true,
    stateFile,
    backendRemoved,
    reason: hadState ? "disconnected" : "forced",
  };
}
