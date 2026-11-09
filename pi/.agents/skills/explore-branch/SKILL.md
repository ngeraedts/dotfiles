---
name: explore-branch
description: >-
  Understand a Git branch's changes, intent, and scope relative to its base.
  Use when the user wants to understand a branch, catch up on someone else's
  work, or get oriented before continuing it.
---

# Explore a Branch

Build context from the branch diff, commits, PR, and linked ticket. This workflow
is read-only. Do not check out another branch or modify the checkout.

## Arguments

Accept an optional branch name, such as
`/skill:explore-branch feature/new-auth`. Default to the current branch.

## 1. Resolve the target

Confirm the current repository with `git rev-parse --show-toplevel`. Do not
search for another repository if it fails.

- For an explicit branch, resolve its local ref or remote-tracking ref. If both
  exist and differ, use the explicitly qualified ref or ask which is intended.
- With no branch argument, use the current branch's ref. For detached HEAD, use
  `HEAD` and identify the commit in the report.
- Record the resolved target ref and its commit SHA. Use that SHA throughout
  this inspection, even when the target is not checked out.
- If the target is unavailable locally, report that and ask before fetching it.

In the examples below, replace `<target-sha>` with the recorded literal SHA.
Do not replace it with the checkout's `HEAD` when inspecting another branch.

## 2. Resolve the base

Read the target branch's open PR when one exists:

```bash
gh pr list --head <target-branch-name> --json number,title,body,url,baseRefName
```

Use the PR's base branch. Otherwise, use a configured comparison base for the
target branch, or detect the repository default from
`git symbolic-ref refs/remotes/origin/HEAD` or read-only repository metadata.
Do not use the feature branch's own upstream as its comparison base.

Resolve the base to an available ref. If its identity or local availability
cannot be established, report the limitation rather than silently using `main`.
Record the merge-base SHA:

```bash
git merge-base <base-ref> <target-sha>
```

Substitute that literal SHA for `<merge-base-sha>` below. Note if the comparison
uses remote-tracking refs whose freshness was not checked.

## 3. Inspect scope and commits

```bash
git diff --stat <merge-base-sha> <target-sha>
git diff --name-status <merge-base-sha> <target-sha>
git rev-list --count <merge-base-sha>..<target-sha>
git log --reverse --format="%h %s%n%b" <merge-base-sha>..<target-sha>
```

Use commit messages to establish intent and important decisions. Distinguish
claims in messages from behavior verified in the code.

## 4. Read the diff and relevant code

```bash
git diff <merge-base-sha> <target-sha>
```

For large diffs, inspect each relevant path separately:

```bash
git diff <merge-base-sha> <target-sha> -- path/to/file
git show <target-sha>:path/to/file
```

When the target is not checked out, read its files with `git show`, not from the
current working tree. Trace callers and related files at the same target commit.
Load applicable domain and framework skills before analyzing that area.

Focus on what changed, why it changed, and how the changes fit together. Inspect
migration implications, authorization boundaries, tests, and incomplete work
when relevant. This is orientation, not a substitute for [[review]] when the
user requests an isolated pre-push review.

## 5. Read related context

Read the target PR's description and relevant comments when available. Fetch
linked Linear issues that explain scope or requirements. Do not use the current
checkout's PR or ticket when exploring another branch.

If inspecting the current branch, report uncommitted changes separately from
the committed diff. Do not include them in branch counts or attribute them to
the target commit.

## 6. Summarize

Report concisely:

- Branch or commit, comparison base, and any freshness limitation.
- Purpose and scope, including commit and file counts.
- Key behavior and architectural changes.
- Relevant test coverage, migration concerns, or incomplete work.
- Remaining uncertainties, distinguished from verified risks.

Group large changes by domain. Explain only history that helps the reader
understand the final change.
