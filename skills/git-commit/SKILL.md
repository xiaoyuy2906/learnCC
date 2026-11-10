---
name: git-commit
description: Write a clear git commit message. Use when the user asks to commit changes.
---

# Git Commit

Follow these steps when committing:

1. Run `git status` and `git diff` to see what changed.
2. Stage only the files that belong to this change.
3. Write the message in this format:
   - First line: a short summary under 60 characters, starting with a verb such as Add, Fix or Remove.
   - Blank line.
   - Body: why the change was made, not what the code does.
4. Run `git commit` with that message.
5. Run `git log -1` to confirm the commit was created.

Never commit files that contain secrets, such as `.env`.
