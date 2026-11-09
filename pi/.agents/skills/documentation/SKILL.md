---
name: documentation
description: Write or review durable documentation and code comments without conversation-context bloat. Use when creating or editing READMEs, guides, API docs, ADRs, inline comments, TODOs, or FIXMEs.
---

# Reader-first documentation

Documentation serves its future reader, not the agent's reasoning process or its conversation with the user.

## Workflow

1. **Decide whether a change is needed.** Do not add documentation or a comment merely because code changed. If the code and existing documentation already communicate what a reader needs, make no documentation change.
2. **Identify the reader and outcome.** Infer both from the artifact's location and purpose. Ask the user only when either is genuinely ambiguous. Every addition must let its reader do or understand something concrete: use a feature, follow a contract, understand a durable decision, or preserve a non-obvious invariant.
3. **Find the right home.** Update the closest existing, expected source of truth. Avoid duplication; create a document only when it has a distinct audience and durable purpose.
4. **Verify, then write.** Check factual claims against the codebase and applicable source of truth. Update or remove stale nearby text when behavior changes.
5. **Perform the reader check.** Before saving, remove anything that does not help the intended reader use, maintain, or safely reason about the system.

## What belongs

Include only durable facts that materially affect reader understanding or action:

- Supported usage, contracts, and constraints.
- Non-obvious invariants, rationale, or surprising behavior.
- Decisions and their meaningful trade-offs. Mention rejected alternatives only when that prevents likely future misuse or reversal.
- Minimal, representative examples that clarify supported use or prevent misuse. Validate examples against current APIs or tooling when practical.

Use direct language and the minimum wording needed for correctness.

## What does not belong

Do not preserve conversational or task context in maintained documentation or code comments, including:

- Agent/user discussion, task logistics, ownership, branch state, or test/debugging steps.
- An implementation chronology, personal preferences, uncertainty, or discarded ideas that do not affect future decisions.
- Explanations of obvious code flow, names, or types.
- Transient task state, unless the artifact is explicitly a changelog, incident record, or handoff.

Keep operational history in its appropriate artifact rather than leaking it into durable documentation.

## Code comments

Comments explain **why**, not **what**. Use them for constraints, invariants, rationale, and behavior that is not clear from the code itself. Do not narrate control flow or leave implementation-session notes.

For a TODO or FIXME:

- Make it specific, actionable, and still valid.
- Create a tracking ticket when one does not exist and the agent is authorized to do so; otherwise ask the user to create one or explicitly flag the missing ticket.
- Reference the ticket in the comment when practical.

## Final checklist

- Is the reader and their outcome clear from the artifact? If not, did I ask?
- Is each claim verified and current?
- Does every sentence earn its place for that reader?
- Did I omit conversation history and transient implementation context?
- Is this information in the right source of truth?
