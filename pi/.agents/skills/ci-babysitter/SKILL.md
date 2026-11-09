---
name: ci-babysitter
description: >-
  Monitor a GitHub PR's checks, inspect failures, and retry verified flakes.
  When the user requests merge-queue monitoring, track queue membership and
  re-enqueue after verified flaky ejections. Use when asked to babysit CI,
  retry flaky jobs, or shepherd a PR through the merge queue.
---

# CI Babysitter

Monitor checks until they pass or a failure needs intervention. Retry only when
failure evidence supports a transient cause. Do not edit code or workflow
configuration as part of monitoring.

## 1. Bind the target and mode

Resolve the explicit PR number or URL, or the current branch's PR. Record its
repository, number, URL, head SHA, base branch, and initial state. Use the same
explicit repository and PR in every later command. For example:

```bash
gh pr view <pr-number-or-url> --repo <owner/repo> \
  --json number,url,state,headRefOid,headRefName,baseRefName,autoMergeRequest
```

- **CI-only:** watch checks and retry verified flakes. Do not enable auto-merge
  or enqueue the PR.
- **Merge queue:** use only when the user requests merging or queue management.
  If the request could mean observation only, clarify before enabling merging.

Use a 60-second polling interval unless the user specifies another. Record
retry counts, run attempts, queue events, and elapsed time. Default limits are
three retries per run ID and three re-enqueues per PR. Do not reset these limits
when a run's attempt number changes.

## 2. Inspect current checks

```bash
gh pr checks <pr-number> --repo <owner/repo> \
  --json name,state,bucket,description,link
```

Use `bucket` for classification: `pass`, `fail`, `pending`, `skipping`, or
`cancel`. Preserve the original state for diagnostics. A nonzero exit status
can mean failed or pending checks, not a failed API request. Exit code 8 means
checks are pending. Distinguish valid status output from auth or query failures.

- Inspect failed or cancelled checks even if other checks remain pending.
- If all returned checks pass or skip, CI-only monitoring is complete. Report
  skipped checks as skipped, not passed. In merge-queue mode, continue until
  merge or another terminal outcome.
- If checks are pending, wait and poll again.
- If no checks are returned, do not claim success. Wait for expected checks.
  Report a blocker if none appear within ten minutes, unless the repository
  documents another normal delay.
- Re-read the PR head SHA and state each cycle. If the head changes, discard
  stale success and failure classifications and evaluate the new head. Do not
  retry stale runs. In merge mode, re-check requirements for the new head before
  taking any merge action.

## 3. Classify failures before retrying

For GitHub Actions links, extract the run ID and verify its SHA, event, latest
attempt, and jobs before reading relevant failed logs:

```bash
gh run view <run-id> --repo <owner/repo> \
  --json headSha,event,status,conclusion,attempt,jobs,url
gh run view <run-id> --repo <owner/repo> --log-failed
```

Classify from actual diagnostics:

- **Transient:** a known flaky signature or a verified temporary runner,
  network, or external-service failure. Record the supporting evidence.
- **Deterministic:** a compile, lint, assertion, configuration, or other failure
  that indicates a reproducible defect. Report it and stop automatic recovery.
- **Unknown:** missing logs, unexplained cancellation, or insufficient evidence.
  Report the uncertainty and ask before retrying.

Passing on the PR branch but failing in a merge group does not establish a
flake. The combined code can expose a real integration failure. Retry exhaustion
also does not prove a failure is deterministic.

For a verified transient failure, wait until the run finishes, then retry once:

```bash
gh run rerun <run-id> --repo <owner/repo> --failed
```

Increment its retry count and wait for the next attempt before evaluating again.
Do not repeatedly rerun the same completed attempt while status updates lag.
On a rerun error, inspect and report it. Do not automatically fall back to a
full-run rerun. Ask before a broader rerun when failed-job retry is unavailable.

For checks from other providers, inspect their linked evidence using authorized
read-only tools. Do not assume GitHub Actions rerun commands apply or invoke
provider mutations without the required authorization.

## 4. Track the merge queue

Use GitHub GraphQL for actual queue membership and recent queue events.
`autoMergeRequest` indicates auto-merge configuration, not queue membership.
For example:

```bash
gh api graphql -f owner='<owner>' -f name='<repo>' -F number=<pr-number> \
  -f query='query($owner:String!, $name:String!, $number:Int!) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        state
        headRefOid
        mergeQueueEntry { position }
        timelineItems(last:10, itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
          nodes {
            __typename
            ... on AddedToMergeQueueEvent { createdAt }
            ... on RemovedFromMergeQueueEvent {
              createdAt
              reason
              actor { login }
              beforeCommit { oid }
            }
          }
        }
      }
    }
  }'
```

Compare events with the recorded membership, head SHA, and event timestamps.
Paginate when ten events do not cover the monitored interval. If queue data is
unavailable, report that limit rather than inferring ejection from auto-merge.

- If already queued, continue monitoring without another enqueue request.
- For an initial authorized enqueue, confirm that the PR is not queued and no
  pending auto-merge request exists. During monitoring, missing membership alone
  does not authorize another enqueue. Apply the removal rules below first.
  For a branch that requires a merge queue:

  ```bash
  gh pr merge <pr-number> --repo <owner/repo> --auto \
    --match-head-commit <verified-head-sha>
  ```

  GitHub enables auto-merge while requirements are pending, or queues the PR
  when ready. Verify the resulting state. Do not bypass requirements with
  `--admin`. If the branch does not use a queue, follow its documented merge
  strategy and the user's merge authorization instead of guessing a strategy.
- For a removal event, inspect its reason and any associated merge-group run.
  Verify that the run belongs to this PR's queue attempt, not an unrelated
  merge group. Apply the failure-classification rules above to its logs.
- Re-enqueue only after a verified transient check failure caused removal,
  within the limit and with a current verified head SHA. Do not undo a manual
  removal, withdrawn approval, or policy block. Ask when the removal cause is
  unclear. A failed merge-group run may no longer be retryable directly, so use
  re-enqueue only when the evidence supports it.

## 5. Stop and report

Stop for merged or closed PRs, deterministic failures, exhausted retry limits,
unknown failures requiring a decision, or unavailable authorization/tooling.
Respect a user request to stop immediately.

Report concisely:

- PR URL, head SHA, and final state.
- Passed, skipped, pending, and failed checks as applicable.
- Failure classification, a short supporting diagnostic, and relevant links.
- Retry and re-enqueue counts, elapsed time, and any action needed.

Do not label unresolved flakes as permanent defects or claim a PR merged from
passing checks alone. Confirm `state == MERGED` before reporting a merge.
