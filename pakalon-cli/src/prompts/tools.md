---
name: tools
description: Tool catalog (full list of tools available to the model).
model: any
tags: [tools, reference]
---

# Pakalon Tool Catalog

The following tools are available to you. Each tool has a name, a
description (shown to the model), and a JSON schema for its arguments.

## File

  • `read(path, offset?, limit?)` — read a file. Use offset/limit for large
    files.
  • `write(path, content)` — overwrite a file. Use for new files or full
    rewrites.
  • `edit(path, old_string, new_string, replace_all?)` — in-place edit.
  • `ast_edit(path, op, anchor, value)` — structured edit using AST nodes
    or hashline anchors.
  • `multi_edit(edits[])` — apply a batch of edits in one round-trip.
  • `hashline_read(path)` — read with hashline anchors for volatile files.

## Search

  • `grep(pattern, path, include?, head_limit?)` — ripgrep-backed search.
  • `glob(pattern, path?)` — file pattern search.
  • `ast_grep(pattern, lang, path?)` — AST-aware structural search.
  • `web_search(query, recency?, top_n?)` — 14-backend chain (Exa, Brave,
    Jina, Tavily, Parallel, Kagi, You, Perplexity, Exa-Neuron, OpenAI,
    Anthropic, Valyu, Cloudflare, DuckDuckGo).

## Shell

  • `bash(command, timeout_ms?, cwd?)` — run a shell command.
  • `process(command, args[])` — long-running process (no timeout).
  • `pty(command, args[])` — interactive terminal (for `vim`, `ssh`, REPLs).

## VCS

  • `git(args[])` — pass-through to `git`.
  • `worktree(action, branch?, path?)` — manage git worktrees (add, list,
    remove, prune, lock, unlock, repair, move).
  • `patches(action, patch_id?)` — apply / revert patches.
  • `commit(message, atomic?)` — atomic commit with auto-split into
    logical units.

## LSP

  • `lsp_definition(file, line, character)`
  • `lsp_references(file, line, character, include_declaration?)`
  • `lsp_rename(file, line, character, new_name)`
  • `lsp_hover(file, line, character)`
  • `lsp_diagnostics(file?)`
  • `lsp_workspace_symbol(query)`

## DAP

  • `dap_launch(adapter, config)` — `debugpy` | `lldb-dap` | `delve`.
  • `dap_set_breakpoint(file, line)`
  • `dap_continue`, `dap_step_over`, `dap_step_into`, `dap_step_out`
  • `dap_pause`, `dap_evaluate(expression)`
  • `dap_threads`, `dap_stack_trace`, `dap_scopes`, `dap_variables`
  • `dap_terminate`

## Browser

  • `playwright_navigate(url)`, `playwright_click(target)`,
    `playwright_type(target, text)`, `playwright_snapshot()`,
    `playwright_screenshot(path?)`
  • `chrome_devtools_*` — DevTools Protocol (CDP) calls
  • `web_fetch(url, format?)` — markdown / text / html

## Memory

  • `hindsight_store(key, value, ttl?)` — long-term memory (vector+SQLite)
  • `hindsight_recall(query, top_k?)` — semantic recall
  • `mnemopi_consolidate()` — Hindsight <-> Mnemopi sync
  • `compact(strategy, target_tokens?)` — branch-summarization compaction

## Sessions

  • `sessions_list()`, `sessions_resume(id)`, `sessions_fork(id, at_message?)`
  • `sessions_share(id, ttl?)` — encrypted share
  • `sessions_snapshot(id)`, `sessions_restore(snapshot_id)`

## Sub-agents

  • `task(agent, prompt, subagent_type?, run_in_background?)`
  • `swarm(task, agents[], strategy?)` — multi-agent fan-out
  • `team(name, role, agent_id)` — persistent team-member

## Internal URLs

These are not tools but **lazy-loaded resources**. The model can fetch
them like any other URL:

  • `pr://N` — pull request N (resolved to diff + comments)
  • `issue://N` — issue N
  • `agent://name` — sub-agent definition
  • `skill://name` — loaded skill
  • `rule://name` — rules file
  • `conflict://N` — conflict marker N (from merge or rebase)
  • `git-overview://branch` — branch summary
  • `fs://abs/path` — file metadata
  • `session://id` — session metadata
  • `tool://name` — tool documentation
