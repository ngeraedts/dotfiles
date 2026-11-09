---
name: goal-loop
description: >-
  Apply a skill or procedure repeatedly until a larger goal is complete.
  Delegate each item to a subagent (pi -p), then verify and commit its changes.
  Use when the user wants to fix all violations, process all files, or complete
  a batch of similar tasks.
---

# Goal Loop

Coordinate sequential work items. Delegate one item at a time to a fresh
`pi -p` process. The coordinator verifies changes and owns commits and pushes.

## Input

Resolve these from the request or repository evidence:

1. The goal and its completion criterion.
2. A command or check that identifies remaining items.
3. The skill or procedure for each item.

Ask only when a required input cannot be resolved. Report the initial item count
and procedure. An explicit request to perform the batch authorizes starting it.

## 1. Establish a safe baseline

Read [[git-commits]] and applicable repository instructions. Inspect the branch,
HEAD, index, working tree, and untracked files before starting.

- Require a clean index and working tree before each item. If user changes are
  present, ask how to isolate the work. Do not automatically stash, discard, or
  commit them.
- Use a dedicated branch. Do not switch branches with pending work without
  approval.
- Record the starting HEAD and permitted paths for the item. Include shared
  configuration files only when the procedure needs them.
- Run subagents and validation in the foreground. Use the global timeout and
  test-database rules. Do not run competing items or checks against the same
  database.

Run the discovery command and check its result before building the initial
ledger. Track each item by a stable identifier with a status: pending, completed,
failed, or deferred. Record attempts and reasons for failed or deferred work. Exclude
failed and deferred items from selection unless an explicit retry is scheduled.

## 2. Select and delegate one item

Prefer independent, low-risk items. Read the delegated skill before launching
it. Give the child the item, permitted paths, relevant constraints, and required
validation. Tell it not to commit, push, switch branches, discard changes, or
interrupt application services. The child shares the checkout and environment,
not the coordinator's conversation history.

Capture full output outside the repository and preserve the process exit status.
For example:

```bash
LOG_FILE=$(mktemp /tmp/goal-loop.XXXXXX)
if pi -p --skill ~/.agents/skills/fix-prefer-alias/SKILL.md \
  "Fix PreferAlias violations in lib/path/to/file.ex. Edit only that file and its exclusion in .credo.exs. Validate the change. Do not commit, push, switch branches, discard changes, or interrupt application services." \
  >"$LOG_FILE" 2>&1; then
  CHILD_STATUS=0
else
  CHILD_STATUS=$?
fi
printf 'Child exit status: %s\nLog: %s\n' "$CHILD_STATUS" "$LOG_FILE"
```

Read the final response and relevant diagnostics from the log with `read`.
A zero process exit status is not proof that the item is complete. Verify the
actual changes and completion criterion. Do not pipe child execution into
`head` or `tail`. For another procedure, replace the skill and item instructions.
Keep normal skill and safety-extension discovery enabled.

## 3. Verify and commit

After the child exits:

1. Confirm the branch and HEAD still match the recorded baseline.
2. Inspect the complete diff, index, and untracked files. Confirm every change
   belongs to this item. Stop for unexpected commits or unrelated changes.
3. Run the focused validation required by the procedure and repository. Preserve
   full output and exit status. Follow global routine-recovery rules.
4. Re-run the item check. Confirm the item no longer needs work.
5. Stage only the verified paths or hunks. Review the staged diff, then create
   a focused signed commit following repository convention.
6. Confirm the checkout is clean before selecting another item.

Do not use `git add -A` or repository-wide reset, checkout, or clean commands as
batch bookkeeping. If checks create unrelated files, inspect them and resolve
their ownership before proceeding.

## 4. Handle failures

Read the full relevant diagnostics before classifying a failure. A timeout is
not a completed child run. Check whether the child or validation process is
still running and wait before starting another command.

- Resolve routine setup problems without changing dependency versions.
- Allow at most one targeted retry per item after the original run has ended.
  Retry only when its changes are understood and isolated.
- If unresolved failure leaves the checkout clean, mark the item failed or
  deferred and continue with other pending items.
- If failure leaves changes, preserve them and pause. Report the affected paths
  and ask how to proceed. Do not automatically revert or delete them to continue.
- Stop for unavailable credentials, unsafe recovery, or repeated systemic
  failures. Do not bypass signing or safety guards.

## 5. Recompute remaining work

After each completed item, run the discovery command again. Reconcile its output
with the status ledger. Add newly discovered items, but do not reset failed or
deferred items to pending. If a completed item reappears, investigate the failed
completion check rather than repeating indefinitely.

Report brief progress: completed count, pending count, failed/deferred count,
and the next item. Respect requested batch limits.

Push completed commits normally at batch boundaries when authorized by the
request. Follow [[git-commits]]. Stop and report a push failure rather than
force-pushing.

## 6. Report the outcome

Claim **Complete** only when a successful discovery check finds no remaining
work. Otherwise report **Partial** or **Blocked**, including failed, deferred,
and unattempted items and their reasons. A discovery-command failure does not
mean there are no items.

Include completed items, commits, push status, validation results, and log paths
needed to investigate failures.

## Common goals

- **PreferAlias exclusions:** discover entries under
  `Credo.Checks.Warning.PreferAlias` in `.credo.exs`, then apply
  [[fix-prefer-alias]] to each file.
- **Other Credo checks:** use the check's JSON output to discover items, then
  apply a focused procedure per file.
- **Refactors:** search for the old pattern, then verify supported behavior and
  the intended final architecture for each change.
