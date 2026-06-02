/**
 * Interleaved thinking policy.
 *
 * Anthropic's "interleaved thinking" feature lets the model emit
 * multiple `thinking` blocks per assistant turn, each one preceding a
 * tool call. This is critical for multi-step tool use (e.g. "before I
 * call edit, think about what the right change is").
 *
 * Policy matrix (model-aware):
 *
 *   claude-opus-4-7, claude-sonnet-4-5, claude-sonnet-4-7,
 *   claude-haiku-4-5, claude-3-7-sonnet  → enabled
 *   claude-3-5-sonnet, claude-3-5-haiku  → disabled (no support)
 *   unknown / unset                      → disabled
 *
 * Override via env: PAKALON_INTERLEAVED_THINKING=1 / 0
 */

const ENABLED_MODELS = [
  /^claude-opus-4-(\d+)/i,
  /^claude-sonnet-4-(\d+)/i,
  /^claude-haiku-4-(\d+)/i,
  /^claude-3-7-sonnet/i,
];

export function isInterleavedThinkingEnabled(request: { model?: string }): boolean {
  const override = process.env.PAKALON_INTERLEAVED_THINKING;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  if (!request.model) return false;
  return ENABLED_MODELS.some((re) => re.test(request.model!));
}

const MARKER = `

[Interleaved thinking enabled. Before each tool call, emit a
\`thinking\` block explaining your reasoning. The model will
interleave thinking and tool calls in the same assistant turn.]
`;

export function buildInterleavedThinkingMarker(): string {
  return MARKER;
}
