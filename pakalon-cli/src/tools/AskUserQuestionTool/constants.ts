/**
 * Constants for AskUserQuestionTool.
 */

/** The free-form "Other" label injected into every question. */
export const OTHER_LABEL = "Other (type a custom answer)";

/** Maximum questions per call (mirrors reference implementation). */
export const MAX_QUESTIONS_PER_CALL = 4;

/** Maximum options per question (excluding the auto-added "Other"). */
export const MAX_OPTIONS_PER_QUESTION = 4;

/** Minimum options per question. */
export const MIN_OPTIONS_PER_QUESTION = 2;

/** Header length cap for the UI. */
export const MAX_HEADER_LENGTH = 12;

/** File format version for persisted answers. */
export const ANSWER_SCHEMA_VERSION = "1.0";
