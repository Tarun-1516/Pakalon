/**
 * RestoreScopePicker — 4-option Ink/React picker for the `/undo` command.
 *
 * Lets the user choose what to restore from a snapshot:
 *   1. Restore Conversation   — rewind the chat history
 *   2. Restore Code           — revert the last file write(s)
 *   3. Restore Both           — both of the above
 *   4. Nothing                — dismiss without any change
 *
 * The choice is returned to the caller as a typed `RestoreScope` union.
 * The component itself does not perform any restore work — it only
 * collects the choice. The caller is responsible for invoking
 * `undoManager.restoreSnapshot({ scope, restoreConversation })` or
 * the equivalent helper in `commands/undo.ts`.
 *
 * Follows the same Ink patterns as `PermissionDialog` and `UndoMenu`:
 *   - `ink-select-input` for arrow-key navigation
 *   - Yellow rounded border for HIL prompts
 *   - Optional dimmed preview of the most recent file changes
 */
import React, { useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { RestoreScope } from "@/ai/undo-manager.js";
import { undoManager } from "@/ai/undo-manager.js";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RestoreScopePickerProps {
  /** Called with the chosen scope when the user picks an option. */
  onSelect: (scope: RestoreScope) => void;
  /** Called when the user picks "Nothing" or hits Escape / cancels. */
  onCancel?: () => void;
  /**
   * Optional short description of the snapshot being undone (e.g. file
   * count, conversation turn count). Shown above the options as context.
   */
  snapshotSummary?: string;
  /**
   * If false, suppress the "Nothing" option (e.g. when nothing to undo).
   * Defaults to true.
   */
  showNothingOption?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const RestoreScopePicker: React.FC<RestoreScopePickerProps> = ({
  onSelect,
  onCancel,
  snapshotSummary,
  showNothingOption = true,
}) => {
  const [done, setDone] = useState(false);

  if (done) return null;

  // ── Build summary lines for context ─────────────────────────────────
  const codeHistory = undoManager.getHistory(5);
  const codePreview = codeHistory.length > 0
    ? codeHistory
        .slice(0, 3)
        .map((s) => `  ${s.operation === "write" ? "[Pencil]" : "[Trash]"} ${s.path.replace(/\\/g, "/")}`)
        .join("\n")
    : "  (no recent file changes)";

  const items: Array<{ label: string; value: RestoreScope }> = [
    {
      label: "1.  Restore Conversation   — rewind chat to previous turn",
      value: "conversation",
    },
    {
      label: `2.  Restore Code           — revert last file write(s) (${codeHistory.length} op${codeHistory.length !== 1 ? "s" : ""})`,
      value: "code",
    },
    {
      label: "3.  Restore Both           — revert files AND rewind chat",
      value: "both",
    },
  ];

  if (showNothingOption) {
    items.push({
      label: "4.  Nothing                — dismiss, no changes",
      value: "nothing",
    });
  }

  const handleSelect = (item: { value: string }) => {
    setDone(true);
    // Type-narrow the string back to the union. The picker only ever
    // emits values from the union, so the runtime check is just a
    // safety net.
    const valid: ReadonlyArray<RestoreScope> = [
      "conversation",
      "code",
      "both",
      "nothing",
    ];
    if (valid.includes(item.value as RestoreScope)) {
      const scope = item.value as RestoreScope;
      if (scope === "nothing") {
        onCancel?.();
        return;
      }
      onSelect(scope);
      return;
    }
    onCancel?.();
  };

  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      flexDirection="column"
      paddingX={1}
      marginY={1}
    >
      <Text bold color="yellow">  Undo — what would you like to restore?</Text>
      <Text> </Text>
      {snapshotSummary && (
        <Text dimColor>{snapshotSummary}</Text>
      )}
      {codeHistory.length > 0 && (
        <>
          <Text dimColor>Recent file changes:</Text>
          <Text dimColor>{codePreview}</Text>
          <Text> </Text>
        </>
      )}
      <SelectInput items={items} onSelect={handleSelect} />
    </Box>
  );
};

export default RestoreScopePicker;
