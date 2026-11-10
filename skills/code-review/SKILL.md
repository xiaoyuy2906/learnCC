---
name: code-review
description: Review code changes for bugs and style problems. Use when the user asks to review code or a diff.
---

# Code Review

Follow these steps when reviewing code:

1. Run `git diff` to see what changed. If there is no diff, ask which files to review.
2. Read each changed file in full before judging it.
3. Look for bugs first: wrong logic, unhandled errors, off-by-one mistakes.
4. Then look at style: unclear names, duplicated code, dead code.
5. Report each problem as `file:line - problem - suggested fix`.
6. End with a one-line verdict: OK to merge, or needs changes.

Do not edit any files during a review.
