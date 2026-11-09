---
name: plan
description: >-
  Analyze a Linear ticket, the current codebase, and any linked Figma designs,
  then write an implementation-ready Markdown plan to .plans/<TICKET-ID>.md.
  Use when asked to plan a ticket, investigate work before implementation, or
  create an engineering plan from the current branch.
user-invocable: true
argument-hint: "[ticket-id-or-url] [additional context]"
---

# Plan a Ticket

Create an implementation-ready plan for a Linear ticket. Investigate thoroughly,
but do not implement the ticket.

A finished plan must resolve all implementation-relevant questions that can be
answered from available evidence. Do not delegate repository investigation,
approach selection, or requirement clarification to the implementer. If a
required answer or source is unavailable, report the blocker. Any saved plan
must be marked as a draft until the blocker is resolved.

## Constraints

- The only repository file this workflow may create or modify is the plan file
  under `.plans/`.
- Always write the finished plan to `.plans/<TICKET-ID>.md`, where `<TICKET-ID>`
  is the canonical uppercase Linear identifier (for example,
  `.plans/FDN-1234.md`). Do not include the title or any other text in the
  filename.
- Base the plan on verified repository evidence. Do not invent modules,
  functions, schemas, routes, or design details.
- Follow all applicable repository instructions and load any relevant domain or
  framework skills before analyzing that area.
- Do not change the Linear ticket, create a branch, implement code, run
  destructive commands, or commit changes.
- Do not overwrite an existing plan without first reading it. Update it in place
  when planning the same ticket.

## 1. Resolve the Ticket

Resolve the ticket identifier in this order:

1. An explicit ticket identifier or Linear URL in the user's prompt or skill
   arguments.
2. The current Git branch name, using a case-insensitive identifier such as
   `fdn-1234` from a branch like `nick/fdn-1234-foo-bar-baz`.

Normalize the identifier to uppercase. If explicit inputs contain different
ticket identifiers, ask the user which one to plan. If no identifier can be
resolved, ask for one.

Fetch the full Linear issue, including its description, comments, parent,
relations, and linked material. Treat later ticket comments as refinements to,
or overrides of, the original description. Read relevant linked issues when they
affect scope or explain dependencies.

If the ticket cannot be found, stop and report that rather than guessing from
the branch slug.

## 2. Establish Scope

Extract and reconcile:

- the user-visible or operational goal;
- explicit acceptance criteria and requirements;
- constraints, exclusions, rollout requirements, and dependencies;
- terminology used by the relevant domain;
- ambiguities or conflicts between the prompt, ticket description, and comments.

The user's current prompt is the highest-priority source, followed by newer
ticket comments, then the ticket description. Resolve meaningful conflicts from
these sources during planning. If the sources do not resolve a conflict that
could materially change the implementation, ask the user before finalizing.

## 3. Inspect Figma When Linked

Collect Figma URLs from the user's prompt, ticket description, comments, and
relevant linked material. For every design that affects the ticket:

1. Browse the Figma file structure first.
2. Inspect the linked node, or identify the relevant frame when the URL only
   identifies a file.
3. Fetch structured design data for layout, component hierarchy, states,
   typography, colors, spacing, and content.
4. Render relevant nodes for visual verification. Do not rely on structured
   properties alone.
5. Inspect Figma comments when they appear relevant to unresolved behavior or
   implementation notes.
6. Compare the design to existing frontend components and patterns in the
   repository.

Record implementation-relevant design behavior, including responsive behavior,
variants, loading/empty/error states, and interactions. If these are absent from
the design, check existing product patterns and choose a conservative approach
where it does not materially change scope or behavior. Record that decision or
assumption. Ask the user when the missing behavior requires a product decision.

If a Figma link is inaccessible, note the limitation prominently in the plan and
do not claim the design was inspected.

## 4. Analyze the Codebase

Investigate from broad architecture to concrete call sites. Use repository
search and read complete relevant files; do not infer behavior from filenames
alone.

At minimum, identify:

- the current execution path for the affected behavior;
- relevant domain contexts, schemas/types, services, API boundaries, UI
  components, workers, configuration, and feature flags;
- authorization, validation, auditing, observability, and error-handling
  patterns that apply;
- database or generated-artifact implications;
- existing tests, fixtures, shared cases, factories, mocks/adapters, and the
  correct test commands;
- analogous implementations that establish the preferred pattern;
- downstream callers or consumers that constrain the change.

Use `git log`, `git blame`, or existing documentation when they clarify why the
current design exists. Consult dependency documentation when the plan depends on
library behavior.

Keep exploration focused on the ticket. Inspect another repository or live
system when the prompt or ticket calls for it, or when that boundary is needed
to verify a stated dependency. If the requested repository cannot establish a
required integration point, record what you checked and ask before probing live
data or expanding the investigation. Do not invent an endpoint from a guess. A
plan should prefer the smallest coherent change that follows existing patterns
and avoids unrelated refactors.

## 5. Resolve the Approach

Choose a concrete implementation approach based on the evidence. Before
proposing a helper, configuration option, wrapper, or abstraction, check whether
an existing API already supports the requirement. New machinery must serve a
current caller or meaningful variation. For refactors, state the architectural
result to verify, not merely the files to move. Explain important design
decisions and rejected alternatives only when the tradeoff is material.

For each proposed test, identify the application-owned failure it detects.
Reuse existing coverage when it already detects that failure. Do not plan tests
of documented dependency functionality or assertions that repeat static
configuration. A removal does not, by itself, require a new test. Delete tests
for retired behavior. Do not add tests that assert a function, module, field,
configuration value, or content no longer exists. Verify removals through diff
review, compilation, and applicable checks. Follow the global test-value rules.

Resolve each implementation-relevant unknown during planning:

- Investigate it when evidence is available.
- Choose and document an approach when it is an engineering decision supported
  by the evidence. Do not defer approach selection to the implementer.
- Ask the user when it requires a product decision or authorization, or when
  missing information could materially change scope, behavior, architecture,
  feasibility, or rollout safety.
- If a required source is unavailable, report what you checked and the specific
  blocker. Do not present the plan as implementation-ready.

Make and record a conservative assumption only when it cannot materially change
scope, behavior, architecture, feasibility, or rollout safety.

Before writing, verify that every proposed file path exists unless the plan
labels it as a new file. Verify that named functions, modules, components, and
test suites exist. Re-check the ticket criteria against the proposed steps so
none are omitted. Remove superseded steps when the user or newer ticket comments
change the approach. Do not carry a rejected behavior into a related ticket or
implementation plan.

Check readiness before finalizing. Review every instruction containing
“confirm,” “verify,” “investigate,” “determine,” or “choose,” and look for other
wording that defers planning work. Resolve that work now. Keep implementation-time
checks only when they require changed code, a deployment, or another future
event. For example, determine which authorization policy applies during planning,
but retain tests that verify the implemented authorization behavior.

## 6. Write the Plan

Create `.plans/` if needed and write `.plans/<TICKET-ID>.md` with this
structure:

```markdown
# <TICKET-ID>: <ticket title>

## Goal
A concise description of the outcome and why it matters.

## Requirements
- Concrete behavior derived from the prompt, ticket, comments, and designs.
- Include important out-of-scope constraints.

## Current State
Describe the relevant existing flow and architecture, citing concrete
repository paths and symbols.

## Proposed Approach
Summarize the implementation strategy and key decisions.

## Implementation Steps
1. **<coherent change>** — `<path/to/existing_or_new_file>`
   - Describe the exact logic, data flow, interfaces, and patterns to change or
     add.
   - Name affected modules/functions/components when verified.
2. Continue in dependency order.

## Test Plan
- Identify existing coverage and any tests to delete for retired behavior.
- Name test files to add or update only where supported behavior or a current
  external contract needs coverage. State the application-owned failure each
  new test detects. A pure removal can require no new tests.
- Include focused commands to run, plus required repository-wide checks.

## Decisions, Assumptions, and Risks
- Record material decisions and permitted assumptions.
- List edge cases, rollout/migration concerns, and verified dependencies.
- Distinguish implementation risks from unresolved planning work. A finished
  plan must not contain unresolved blockers.
- Write `None` if there are none.

## References
- Linear: <ticket URL>
- Figma: <relevant URLs, if any>
- Related code/docs: `<paths>`
```

Adapt headings when useful, but always include the goal, requirements, current
state, proposed approach, ordered implementation steps with file paths, test
plan, decisions/assumptions/risks, and references.

The plan must be detailed enough that another engineer can implement it without
repeating the investigation. Keep it concise and specific: explain what must
change and why, but do not include full implementation code or speculative
pseudocode.

## 7. Report

Report one of these outcomes:

- **Ready:** the plan path and a one-sentence approach summary. Use this outcome
  only after the readiness check passes.
- **Blocked:** the specific missing answer, authorization, or required source,
  and the question or access needed to proceed. If a draft was saved, give its
  path and mark it clearly as incomplete in both the file and the report.

Do not paste the entire plan into the response unless the user asks.
