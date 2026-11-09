---
name: git-commits
description: Git commit best practices. Use whenever creating commits, pushing changes, or working on branches that have open PRs or are under review.
---

# Git Commit Practices

## Rules

1. **Never amend commits that have been pushed** — `git commit --amend` followed by `git push --force` rewrites shared history. This is destructive to reviewers who have already seen the original commits.

2. **Never disable GPG/SSH signing** — Do not pass `--no-gpg-sign`, `-n`, or set `commit.gpgSign=false` to bypass commit signing. The signing key is managed via 1Password and may require user interaction to unlock. If a commit fails due to signing errors, **stop and ask the user** to unlock 1Password or resolve the issue. Do not retry with signing disabled.

3. **Do not force push by default** — A request to rebase authorizes the final `--force-with-lease` push of the same feature branch after successful validation. Follow the rebase skill and do not ask for a second confirmation. Other force pushes require explicit user approval. If a leased push is rejected, investigate and report the failure. Do not automatically retry, refresh the lease, or fall back to plain `--force`.

4. **Create new commits instead of amending** — When making follow-up changes (e.g. addressing review feedback, fixing something you just committed), create a new commit with a clear message describing what changed. This preserves history and makes review easier.

5. **Write clear commit messages** — Each commit message should describe *what* changed and *why*. Use imperative mood (e.g. "Fix null check in user lookup", not "Fixed null check").

6. **Keep commits focused** — Each commit should represent one logical change. Don't bundle unrelated changes together.

## When the user explicitly asks to amend or force push

If the user specifically requests amending or force pushing, that's fine — follow their instructions. These rules are about default behavior, not overriding explicit user intent.
