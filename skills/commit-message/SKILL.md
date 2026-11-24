---
name: commit-message
description: Write concise Conventional Commit messages from actual changes. Use when drafting a commit message or when the user asks to commit changes.
---

# Commit Message

Inspect `git status` and the relevant diff before writing. For a commit, use the
staged diff. Describe only the changes included in the commit.

Follow Conventional Commits and the 50/72 rule:

- Subject: `<type>(<scope>): <summary>`, imperative mood, lowercase, at most
  50 characters, no final period.
- Body: explain why and what. Leave a blank line after the subject and wrap
  body lines at 72 columns.
- Types: `feat`, `fix`, `perf`, `refactor`, `style`, `docs`, `test`, `build`,
  `ci`, `chore`.
- Do not add `Signed-off-by`.

Check the message against the diff and line limits. Do not invent test results.
A request for a message does not authorize a commit. Commit only when explicitly
asked, and do not include unrelated changes.
