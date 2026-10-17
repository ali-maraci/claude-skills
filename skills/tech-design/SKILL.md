---
name: tech-design
description: Use when a product-approved ticket (e.g. from a grilling session, already spec'd into a Jira ticket) needs its technical layer — architecture and program design — worked out on paper before any code, and before handing the ticket to task-lifecycle to build. For real features that touch multiple files/repos, add endpoints/tables/screens, or produce large diffs. Not for renames, copy changes, or one-line config edits.
---

# Tech Design

## Overview

Produce the **technical design** for a ticket whose *product* scope is already approved (the product spec step did the *what*). This is the "how, on paper, before code" layer — Dex Horthy's Software Factory **Architecture** and **Program Design** gates.

Core principle: **make every technical decision before implementation code exists, where changing it costs a sentence instead of a rewrite.**

This skill slots into an unchanged pipeline:

```
product spec (e.g. mattpocock-skills:grilling)  →  ticket (product approved)
   →  /tech-design PROJ-123      ← THIS SKILL: architecture + program design
   →  task-lifecycle PROJ-123    ← builds from the now-complete ticket
```

Any product-spec skill can produce that spec instead (optional).

## When to use / not

**Use** when picking up a product-approved ticket that's a real feature (multiple files, new endpoints/tables/screens, 100+ line diff, or spans repos) and you're about to build it.

**Skip** for trivial tweaks (rename, copy change, one-line config), throwaway prototypes, or when the user explicitly wants speed. Say so and go straight to task-lifecycle.

**Do NOT re-derive product scope.** Product/acceptance comes from the product spec step — treat it as fixed input. If it's wrong, that's a re-run of that step, not a tech-design job.

## The load-bearing constraint (read this first)

**task-lifecycle reads ONLY the Jira ticket.** Not this chat, not your local files. So:

> Anything the build MUST have goes IN the ticket. Local `.scratch/` files are a convenience mirror, never a source of truth. The only way task-lifecycle can "know about" a scratch file is a pointer line you put in the ticket — and even then the ticket must stand alone if that path doesn't exist.

## Workflow

### 1. Ground in the real code first (REQUIRED — do not skip)

Before writing a word of design, read the repos you'll touch:
- Read the workspace `CLAUDE.md` for the repo map (what each repo owns, how they fit together), then grep/read the repos relevant to this ticket.
- Find what already exists to reuse: background jobs, endpoints, tables and migrations, shared client interfaces, notification pipelines, the auth model.

A design that invents a new mechanism where one already exists is the most expensive mistake here. Cite real file paths in the design.

### 2. Write `architecture.md` (system altitude)

REQUIRED sections — fill every one:

- **Fit:** Which repos from the workspace map are touched, and how each changes. Name the existing components you reuse.
- **Endpoints:** route · verb · purpose, one per line (or "none").
- **Data:** New/changed tables — which migration file (next free prefix in the repo's convention), column naming per the repo's convention, query outlines.
- **Flow:** End-to-end call sequence for the main path.
- **External + compliance:** Third-party APIs, env var names, webhooks (or "none"), PLUS the project guardrails for this ticket (see below).

### 3. Write `program-design.md` (code altitude — per repo)

REQUIRED sections — models often skip these, so fill every one explicitly:

- **Files:** Every created/changed file + a one-line rationale.
- **Types & signatures:** Code blocks with **signatures only, no bodies** — function/method signatures, type/interface shapes, DDL sketch. This is mandatory, not optional.
- **Call stack:** What calls what, top to bottom, per flow. Explicit, not implied by prose.
- **Test seams:** The public boundaries the tests will exercise (module interface, route handler, component props, etc.) and which behaviours get tested at each. These are the **pre-agreed seams** `/mattpocock-skills:tdd` requires — approving the design confirms them, and task-lifecycle's builder tests only here. Pick the critical paths and complex logic, not every edge.
- **Test plan:** Test case **names + assertions**, written before the tests exist, mapped to acceptance criteria and to the seam each one runs at.
- **Build slices:** 1–4 ordered slices, each `name` + `scope` + the `seams` it tests at (task-lifecycle takes this list verbatim, one builder per slice). **Slice 1 is the tracer bullet:** the thinnest happy path through *every* layer the ticket touches (e.g. route → service → DB → UI), real code and real tests, not a stub. Later slices widen it (edge cases, error paths, more variants, polish). **Never one slice per layer** — "schema, then API, then UI" hides integration mistakes until the last slice. A small or single-layer ticket (schema-only, a wide mechanical refactor) is one slice; say so.
- **Least-confident decisions:** A **numbered** list of the calls most worth challenging. (Not vague "open questions" — the specific decisions you'd want a second opinion on.)

### 4. Record & hand off (the contract)

Do all three — this is the mechanic that is easiest to skip:

1. **Write the full design INTO the ticket** (the only artifact task-lifecycle reads). Use Atlassian MCP `editJiraIssue` to append a **"Technical Design"** section, or `addCommentToJiraIssue` as a pinned comment if you don't want to touch product's description. Keep product/acceptance clean at the top; put the heavy Program Design (files, signatures, call stack, test seams, test plan, build slices, least-confident) in a **subtask or code panel** so it's one click down, not drowning the description. It must be **self-contained**.
2. **Mirror both docs to `.scratch/<TICKET>/`** — `architecture.md` + `program-design.md`, local only, never committed (keep spec/design docs out of commits; `.gitignore` if needed).
3. **Drop a pointer line in the ticket:** `Full design (local mirror): .scratch/<TICKET>/`. This is the only way task-lifecycle can discover the scratch copy — and it stays purely optional.

### 5. Approve, then hand off

Present a 5–10 bullet summary + the ticket key and scratch path (don't paste the full design into chat). Ask: **"Approve the tech design for <TICKET>, or what should change?"** Mutating a real ticket needs an explicit go-ahead — never write to the ticket before approval. On approval, the ticket is ready for `task-lifecycle <TICKET>`.

## Project guardrails (bake into every ticket)

- **Project guardrails:** copy the constraints listed in the workspace `CLAUDE.md` (e.g. data residency, approved LLM providers, audit logging, synthetic test data) into the ticket's design. Call out any change the ticket makes to them.
- **Never put secrets or real user data** in the ticket, design, or fixtures — you are writing design detail into Jira, so this is live.
- **Cross-repo sequencing:** when one repo consumes another's change, the producing PR lands **before** the consuming PR. State the order in the ticket.
- **Branch naming:** `feature/<TICKET>_snake_desc` (features) or `fix/<TICKET>_snake_desc` (bugs), ticket key verbatim.

## Optional hardening hook

The **least-confident decisions** list is the natural handoff to a second opinion when a ticket is risky (auth, schema, migrations, concurrency, payments, personal data). If the user wants it, feed that list to `grilling` (interview) or `claudex-loop:codex-review` / `claudex-loop:claudex-loop` (cross-model, from the [claudex-loop](https://github.com/chaseai-yt/claudex-loop) plugin) before step 5. **Off by default** — the product spec step already covered the product layer; only escalate the technical layer when the stakes call for it.

## Common mistakes

| Common mistake | Fix |
|---|---|
| Scratch = private notes, nothing points to it | Scratch is a **mirror** of the two docs + a **pointer line in the ticket** |
| Program design stops at file paths | Force **type/function signatures** and an explicit **call stack** |
| "Open questions" instead of ranked risks | A **numbered least-confident-decisions** list |
| Designing without reading the repo | Step 1 is **required**: grep/read before writing; cite real paths |
| Architecture + program design as one blob | Two distinct artifacts — different altitudes, may span different repos |
| Re-deriving product scope | Product is the spec step's fixed input; don't touch it |
| Build slices cut by layer (schema → API → UI) | Slice 1 is a **tracer bullet** through every layer; later slices widen it |
| Writing to the ticket before approval | Explicit go-ahead first — it mutates the system of record |

## Quick reference

1. Read the real code (required) → 2. `architecture.md` → 3. `program-design.md` → 4. into Jira + `.scratch/<TICKET>/` mirror + pointer line → 5. approve → `task-lifecycle`.
Everything load-bearing lives in the ticket. Scratch is a convenience. Guardrails go in the ticket.
