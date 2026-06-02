/**
 * /privacy — toggle privacy mode.
 *
 * When enabled: Mem0 is disabled, telemetry is suppressed, the
 * `X-Privacy-Mode: 1` header is sent on every backend request.
 *
 * Sub-commands:
 *   on | off | status | reset-machine-id
 *
 * `reset-machine-id` performs a Cursor-style Fake Machine ID reset —
 * all three telemetry IDs are replaced with cryptographically random
 * values to sever the link to prior telemetry.
 */
import { setPrivacyMode, isPrivacyMode } from "@/settings/cli-settings.js";
import {
  getMachineIds,
  randomizeMachineIds,
  resetMachineIds,
} from "@/telemetry/machine-id.js";
import logger from "@/utils/logger.js";

export { isPrivacyMode } from "@/settings/cli-settings.js";

export function setPrivacy(enabled: boolean): { privacyMode: boolean } {
  const s = setPrivacyMode(enabled);
  logger.info({ enabled }, "Privacy mode toggled");
  return { privacyMode: s.privacyMode ?? false };
}

export function togglePrivacy(): boolean {
  const next = !isPrivacyMode();
  setPrivacy(next);
  return next;
}

export interface PrivacyStatus {
  privacyMode: boolean;
  machineId: string;
  macMachineId: string;
  devDeviceId: string;
}

export function getPrivacyStatus(): PrivacyStatus {
  const ids = getMachineIds();
  return {
    privacyMode: isPrivacyMode(),
    machineId: ids.machineId,
    macMachineId: ids.macMachineId,
    devDeviceId: ids.devDeviceId,
  };
}

/**
 * Cursor-style "Fake Machine ID" reset. Replaces all three IDs with
 * random values (no hardware fingerprinting). Use to start with a
 * clean telemetry slate.
 */
export function resetMachineId(): { mode: "reset" | "randomized"; ids: PrivacyStatus } {
  const ids = randomizeMachineIds();
  return { mode: "randomized", ids: { ...getPrivacyStatus(), privacyMode: isPrivacyMode() } };
}

/**
 * Standard "reset" — generates new IDs that are still derived from
 * hardware, preserving the same shape.
 */
export function rotateMachineId(): { mode: "reset" | "randomized"; ids: PrivacyStatus } {
  const ids = resetMachineIds();
  return { mode: "reset", ids: { ...getPrivacyStatus(), privacyMode: isPrivacyMode() } };
}
