/**
 * hashline/index.ts — re-exports for the content-hash edit-anchor module.
 */
export {
  lineHash,
  lineHash4,
  lineHash8,
  encodeLines,
  renderAnnotated,
  parseAnchor,
  verifyAnchor,
  applyLineEdits,
  splitLines,
} from "./encode.js";

export type {
  AnnotatedLine,
  EncodeOptions,
  RenderOptions,
  VerifyStatus,
  VerifyResult,
  LineEdit,
  ApplyResult,
} from "./encode.js";
