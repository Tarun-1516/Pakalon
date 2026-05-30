/**
 * Session Memory prompts for pakalon-cli.
 * Handles template loading and prompt building for session memory extraction.
 */

import { getSessionMemoryPath } from "./sessionMemoryUtils.js";

// ============================================================================
// Templates
// ============================================================================

const SESSION_MEMORY_TEMPLATE = `# Session Memory

## Project Context
- Project: (auto-detected)
- Started: (auto-detected)

## Key Decisions
<!-- Key architectural and design decisions made during this session -->

## Important Context
<!-- Important context that should persist across the session -->

## Progress Notes
<!-- Notes on what has been accomplished -->

## Open Questions
<!-- Questions or items that need follow-up -->

---

*Last updated: (auto-detected)*
`;

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Load the session memory template
 */
export async function loadSessionMemoryTemplate(): Promise<string> {
  return SESSION_MEMORY_TEMPLATE;
}

/**
 * Build the prompt for updating session memory
 */
export async function buildSessionMemoryUpdatePrompt(
  currentMemory: string,
  memoryPath: string
): Promise<string> {
  return `You are updating the session memory file for the current conversation.

Current session memory file location: ${memoryPath}

Current session memory content:
---
${currentMemory || "(empty)"}
---

Your task is to update this session memory file with important information from the current conversation. Focus on:

1. **Key Decisions**: Any architectural or design decisions made
2. **Important Context**: Critical context that should persist
3. **Progress Notes**: What has been accomplished
4. **Open Questions**: Items needing follow-up

Rules:
- Keep the file concise and focused
- Only include truly important information
- Preserve existing structure
- Update the "Last updated" timestamp
- Do NOT include sensitive information like API keys or passwords

Please update the session memory file with the relevant information from the conversation.`;
}

/**
 * Build a prompt for manual session memory extraction
 */
export async function buildManualExtractionPrompt(
  messages: string,
  currentMemory: string
): Promise<string> {
  return `You are manually extracting session memory from a conversation.

Current session memory:
---
${currentMemory || "(empty)"}
---

Conversation to extract from:
---
${messages}
---

Please extract important information and update the session memory file with:
1. Key decisions and architectural choices
2. Important context and constraints
3. Progress made
4. Open questions or follow-ups

Keep it concise and focused on what matters for continuing this work.`;
}
