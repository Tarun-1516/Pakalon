---
name: doc-gen
description: Auto-generate API documentation.
model: anthropic/claude-sonnet-4-5
tags: [phase-6, documentation]
defaults:
  output_path: "./API.md"
  format: "markdown"
---

# Documentation Generation

You are generating API documentation for a project. The user has asked you
to produce a complete reference based on the source code.

## Process

  1. Walk the repo, identifying public APIs (exported functions, types,
     classes, REST routes, CLI commands, MCP tools, plugin hooks).
  2. For each item, extract:
     • Name
     • Signature (parameters + types)
     • Return type
     • One-line description
     • At least one usage example (constructed from existing tests if
       possible)
     • Edge cases / errors thrown
  3. Group by module / package.
  4. Emit a `{{output_path}}` in `{{format}}` format.

## Style

  • Use headings (one per module) and sub-headings (one per item).
  • Code blocks: use the project's language tag.
  • Cross-link related items with relative paths.
  • Include a top-level table of contents.
  • Keep examples short (≤10 lines) and runnable.

## Anti-patterns

  • Do not document private / internal functions.
  • Do not paste entire source files into the docs.
  • Do not include commented-out code.
  • Do not include TODO markers.
  • Do not include git history or "Last updated" footers.

## Validation

After writing, run the docs through:
  • `markdownlint` (if the project has it).
  • A link-checker to ensure all cross-links resolve.
  • A `grep` for `TODO` and `FIXME` to ensure none leaked in.
