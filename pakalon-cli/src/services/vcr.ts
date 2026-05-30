/**
 * VCR (Video Cassette Recorder) Service for pakalon-cli
 *
 * Provides test fixture recording and playback for API responses.
 * Caches API responses to avoid repeated calls during testing.
 */

import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getCwd } from "@/utils/cwd.js";
import logger from "@/utils/logger.js";

// ============================================================================
// Types
// ============================================================================

type FixtureEntry<T> = {
  input: unknown;
  output: T;
};

// ============================================================================
// VCR Service
// ============================================================================

/**
 * Check if VCR mode is enabled
 */
function shouldUseVCR(): boolean {
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  if (process.env.USER_TYPE === "ant" && process.env.FORCE_VCR === "1") {
    return true;
  }
  return false;
}

/**
 * Generic fixture management helper
 * Handles caching, reading, writing fixtures for any data type
 */
async function withFixture<T>(
  input: unknown,
  fixtureName: string,
  f: () => Promise<T>
): Promise<T> {
  if (!shouldUseVCR()) {
    return await f();
  }

  const hash = createHash("sha1")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 12);
  const filename = join(
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT ?? getCwd(),
    `fixtures/${fixtureName}-${hash}.json`
  );

  // Fetch cached fixture
  try {
    const cached = JSON.parse(
      await readFile(filename, { encoding: "utf8" })
    ) as T;
    return cached;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw e;
    }
  }

  if (process.env.CI && process.env.VCR_RECORD !== "1") {
    throw new Error(
      `Fixture missing: ${filename}. Re-run tests with VCR_RECORD=1, then commit the result.`
    );
  }

  // Create & write new fixture
  const result = await f();

  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(result, null, 2), {
    encoding: "utf8",
  });

  return result;
}

/**
 * Record or replay API responses for testing
 */
export async function withVCR<T>(
  input: unknown,
  fixtureName: string,
  f: () => Promise<T>
): Promise<T> {
  return withFixture(input, fixtureName, f);
}

/**
 * Record or replay streaming responses for testing
 */
export async function* withStreamingVCR<T>(
  input: unknown,
  fixtureName: string,
  f: () => AsyncGenerator<T>
): AsyncGenerator<T> {
  if (!shouldUseVCR()) {
    return yield* f();
  }

  const buffer: T[] = [];
  for await (const item of f()) {
    buffer.push(item);
  }

  // Record to fixture
  const hash = createHash("sha1")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 12);
  const filename = join(
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT ?? getCwd(),
    `fixtures/${fixtureName}-${hash}.json`
  );

  try {
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, JSON.stringify(buffer, null, 2), {
      encoding: "utf8",
    });
  } catch (error) {
    logger.warn("[VCR] Failed to write fixture:", error);
  }

  yield* buffer;
}
