---
name: ship
description: >-
  Take a Linear ticket through a verified implementation plan, implementation,
  validation, and a draft PR assigned to the user. Use when a developer says
  "ship this ticket", "ship FDN-123", "implement and PR this", or wants a
  ticket taken from backlog to draft PR. Coordinates plan → implement-plan.
user-invocable: true
argument-hint: <ticket-id-or-url>
---

# Ship a Ticket

Coordinate [[plan]] and [[implement-plan]] to take a Linear ticket through a
draft PR. Read and follow each skill at its phase. Do not replace their workflows
with an informal plan or a separate commit-and-PR procedure.

## Constraints

- Work autonomously within the request and the delegated skills' constraints.
  Resolve routine setup problems using the global recovery rules. Ask when a
  material decision, authorization, or required source is missing.
- Follow applicable repository instructions and load the relevant domain skills.
- Preserve user changes. Branch preparation, validation, visual evidence,
  signed commits, pushing, PR creation, and Linear updates belong to
  [[implement-plan]]. Do not perform a second copy of those steps.
- This workflow does not authorize merging, deployment, or unrelated changes.

## 1. Plan

Read and follow [[plan]] with the user's ticket reference and additional context.
It resolves the ticket, investigates the requirements and implementation, and
writes `.plans/<TICKET-ID>.md`.

- Continue only when the plan passes its readiness check and reports **Ready**.
- If planning reports **Blocked**, ask for the specific missing answer or access
  and wait. Do not implement or commit a partial solution to bypass the blocker.
- Do not require a separate approval of a ready plan unless the user requested
  that approval gate.

## 2. Implement

Read and follow [[implement-plan]] using the ready plan's path. Let that workflow
validate the plan against current requirements, prepare the branch, implement,
run checks, capture applicable frontend evidence, and create or update the PR.

If a required implementation decision becomes unresolved, preserve the current
work and report the blocker. Do not invent missing details or publish incomplete
work merely to complete the workflow. Follow [[implement-plan]] for its explicit
exceptions, such as a draft PR with unavailable visual proof.

## 3. Report

Give the implementation summary, validation results, draft PR URL, and any
remaining blockers. Include frontend evidence details when required by
[[implement-plan]]. Do not repeat intermediate reports or paste the plan.
