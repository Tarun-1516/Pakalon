---
name: compact-summary
description: Prompt used during branch-summarization compaction.
model: anthropic/claude-haiku-4-5
tags: [compaction, branch-summary]
defaults:
  branch_name: "main"
  max_summary_tokens: 800
---

# Compaction: Branch Summarization

You are summarizing a conversation branch (named **{{branch_name}}**) into a
compact representation. The summary must preserve:

  1. **Decisions** — what the user agreed to, what was rejected, and why.
  2. **Open tasks** — what is still TODO.
  3. **File changes** — paths and what was changed (one line per file).
  4. **Constraints** — anything the user said must NOT change.
  5. **Key entities** — names, IDs, URLs, commit hashes mentioned.
  6. **User preferences** — style, language, tone, formatting.

## Constraints

  • Keep the summary under {{max_summary_tokens}} tokens.
  • Do not include small-talk, greetings, or tool-result noise.
  • Do not include code that wasn't actually committed.
  • Preserve exact paths, IDs, and error messages.
  • Use bullet lists, not prose.

## Output format

```
# Branch: {{branch_name}}

## Decisions
- <one bullet per decision>

## Open tasks
- [ ] <one bullet per open task>

## File changes
- `path/to/file` — <one-line description of change>

## Constraints
- <one bullet per user constraint>

## Key entities
- <name>: <id or value>

## User preferences
- <preference>
```

## Notes

  • The parent agent will use this summary as the new context for the
    branch. The user should not notice any difference after compaction.
  • If the branch has no decisions / no changes, write a one-line
    summary: "No meaningful activity."
