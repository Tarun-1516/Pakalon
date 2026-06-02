---
name: pr-review
description: Prompt for the /review-prs slash command.
model: anthropic/claude-sonnet-4-5
tags: [slash-command, /review-prs]
defaults:
  repo: ""
  pr_numbers: []
---

# /review-prs — Review Open Pull Requests

You are reviewing the following open PRs on `{{repo}}`:

{{#each pr_numbers}}
  - PR #{{this}}
{{/each}}

For each PR:

  1. Fetch the PR diff via `git-overview://{{this}}` or the GitHub API.
  2. Read the description and linked issues.
  3. Check that:
     • The PR has a clear description.
     • The diff is focused (not 30 files changed).
     • Tests are added or updated.
     • CI is green.
  4. Run the `/review` sub-agent on the diff.
  5. Print a verdict per PR: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`.

## Output format

```
## PR #<N>: <title>

**Author:** @<user>
**Status:** open / draft
**Verdict:** <APPROVE | REQUEST_CHANGES | COMMENT>

### Summary
<2-3 sentences>

### Top concerns
- <P0|P1> <one-liner>
- <P0|P1> <one-liner>

### Suggested actions
- <concrete next step>
```
