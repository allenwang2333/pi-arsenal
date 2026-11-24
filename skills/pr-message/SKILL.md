---
name: pr-message
description: Write a GitHub pull request title and body from the current branch changes, then create the pull request. Use when opening a pull request.
---

# PR Message

Write the PR title and body from the actual branch changes (`git log` / `git diff`
against the default branch). The user's request text is context for the message,
never shell input.

- Title: short, imperative, describes the user-visible change.
- Body: `## Summary` (what changed and why) and `## Testing` (actual command and
  result, or "Not run"). Add risks/migrations only if the diff supports them.
  Never invent results.

Before creating, block with `Result: BLOCKED` if: not a repo or HEAD is on the
default branch; the tree is dirty; `gh` is missing or unauthenticated; commits
are unpushed; the diff vs the default branch is empty.

Skip with `Result: EXISTS` + URL if an open PR already exists for the branch.

Create: write the body to a temp file, run `gh pr create --title "..." --body-file <file>` once, then remove the temp file. Never `git add`/`commit`/`push` or use `--fill`.

End with exactly one result line, with the URL when known:

```text
Result: CREATED | EXISTS | BLOCKED | FAILED
URL: <url>
```
