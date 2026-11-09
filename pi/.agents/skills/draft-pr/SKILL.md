---
name: draft-pr
description: >-
  Commit the requested pending changes when needed, push the branch, and open a draft PR
  assigned to the current user. Use when the user wants to commit and open a
  draft PR, push a draft PR, or get a PR started quickly.
---

# Draft PR Skill

Commit current changes, push the branch, and open a draft GitHub PR assigned to
the user.

## Procedure

1. **Inspect the branch** — Load [[git-commits]]. Check `git status`, the
   current branch, upstream, outgoing commits, and any existing PR. Resolve the
   intended base from the user's request, branch configuration, or repository
   default. Compare the branch with that base. A clean working tree does not
   mean there is nothing to push or open a PR for. Stop only when there are no
   requested pending changes, no outgoing commits, and no branch changes needing
   a PR or existing PR update. Do not publish directly from the default branch
   or switch branches with user changes without approval.

2. **Stage requested changes when present** — Inspect the diff and untracked
   files. Stage only files or hunks belonging to the request. Do not include
   unrelated user changes. Ask when ownership is unclear or unrelated changes
   are already staged. Do not silently unstage user work to prepare the commit.

3. **Commit when needed** — Use a supplied message, or generate one from the
   staged diff using repository convention and the ticket ID when known. Do not
   ask for a message unless the user requested approval or the intended change
   is unclear. Review the staged diff and run required repository checks before
   committing and pushing. Preserve signing and follow [[git-commits]]. If
   there is nothing new to commit, continue with the existing branch commits.

4. **Push when needed** — Follow required pre-push checks for the current
   commits even when no new commit was needed. If commits are outgoing or the
   remote branch does not exist, push the current branch to origin:
   ```bash
   git push -u origin HEAD
   ```
   If the push fails, report the error and stop.

5. **Open draft PR** — Use `gh` CLI to create a draft PR assigned to the user:
   ```bash
   gh pr create --draft --assignee @me --base <base-branch> \
     --head <head-branch> --title "<title>" --body "<body>"
   ```
   - **Title**: Use a user-provided title or summarize the full branch change
     using repository convention. Include the ticket ID when known.
   - **Body**: Use the user's description when provided. Otherwise follow the
     PR description rules below. Don't leave it empty.
   - **Base branch**: Use the base resolved in step 1. Pass explicit `--base`
     and `--head` values when creating the PR.
   - **Existing PR**: Do not create another PR. Push the requested commits and
     update relevant description or evidence only when needed. Preserve
     unrelated body content and the PR's existing draft/ready state.

6. **Report** — Print the PR URL so the user can find it easily.

## PR description

Use the repository's PR template when present and fill its required sections.
Otherwise keep the description short: what changes, why, and any material risk
or limitation. Reference the ticket when known. Include applicable frontend
evidence using the rules below.

Write for a reviewer of the final diff, not an agent continuing the task. Omit
plan instructions, implementation chronology, routine check transcripts, and
validation sections unless the template requires them. Report routine check
results in the completion message. Include validation failures or gaps in the
PR when they materially affect review.

## Frontend screenshots

For frontend work, inspect the diff before creating the PR. If it contains a
user-visible visual change, load and follow the `frontend-screenshot` skill.
Capture a focused feature region and visually inspect it. Use an existing
visual-evidence section in the PR template, or add `## Screenshots/Gifs` for
this frontend change. Include a matching local image reference. Create the PR
with GitHub CLI's `--attach` flag in the same command so GitHub replaces that
reference with its permanent attachment URL.

If the diff has no user-visible frontend visual or interaction change, skip the
screenshot. Do not add a screenshot or visual-evidence section to a backend PR
just to state that it does not apply. If the repository's PR template already
contains such a section, fill it as the template requires. Validation messages,
loading states, disabled controls, navigation changes, and other interaction
feedback count as visual changes.

The `frontend-screenshot` skill is the canonical source for capture, attachment,
and verification rules. Do not improvise another image-hosting method or use a
gist.

## Notes

- Inspect the full branch diff for frontend evidence even when there were no
  pending working-tree changes. For an existing PR, use the screenshot skill's
  edit-and-verify procedure rather than the PR-creation command.
- Respect all rules from the `git-commits` skill (no amending pushed commits, no
  force push, signing enabled).
- If the branch doesn't exist on the remote yet, `git push -u origin HEAD`
  handles that.
