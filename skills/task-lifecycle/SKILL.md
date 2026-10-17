---
name: task-lifecycle
description: Use when taking a feature, ticket, or bugfix from "build it" through to an open PR in any repo — or when the user says "run the full lifecycle", "take this all the way", "build, review and ship this", or asks for a task to be built and PR'd end to end. Also use when picking a task back up after review, verification, or PR comments.
---

# Task Lifecycle

Takes one task from seams → build → review → fix → verify → final review → PR. **The pipeline runs as one Workflow script in two stages** shipped with this skill; the main session only resolves inputs, runs the stages, relays their structured results to the user at the gates, and opens the PR. Every judgement and every edit happens inside a workflow agent. If you are editing source, reading a diff, running the test suite, or driving a browser inline, you have left the skill.

One task per run. Two independent tasks = two runs.

**Done means all of:** tests written test-first and the full suite + typecheck green on the final commit · committed on the task branch · reviewed · every acceptance criterion evidenced (recording or named test) · verified against the running app · PR open · reported on Slack (when the Slack MCP is configured). A PR on red tests is not done.

## Companion skills

The agents invoke these by name. Install them first; the pipeline degrades only where noted.

| Skill | Where to get it | Used for |
|---|---|---|
| `mattpocock-skills:tdd` | public plugin `mattpocock-skills` | builders and fixers write tests first at the agreed seams |
| `superpowers:receiving-code-review` | public plugin `superpowers` | the assessor weighs PLAUSIBLE review findings with technical rigour |
| a strict maintainability-review skill (optional) | any skill you trust, e.g. `thermo-nuclear-code-quality-review` | the structure review; skipped if absent |
| `superpowers:brainstorming` (optional) | public plugin `superpowers` | resolving open design questions with the user |

## Pipeline

| Step | Where | Models |
|---|---|---|
| 1. Resolve inputs → brief file | one Sonnet agent, then the main session asks the user **only** if the ticket names no test seams | sonnet |
| 2. `stage: "build"` | Workflow: slice builders (the last one runs the diff scout) → reviewers (one owner per question) → route → assessor for PLAUSIBLE findings → fix, cap 1 fix round | sonnet build/fix · opus review/assess |
| 3. Gate check | main session reads the result: `blocked` → stop and tell the user; else continue | — |
| 4. `stage: "verify"` | Workflow: verify per surface × criteria group → fix verification failures (cap 2) → final incremental review once if code changed → gate | sonnet verify/fix · opus review · haiku gate |
| 5. Setup gate | `blocked.stage == 'verify:setup'` → tell the user what is missing and wait; once fixed re-run step 4 with `attempt: 2` **and** `resumeFromRunId` (see Resuming). "Open the PR, I'll test manually" → re-run step 4 with `skipVerify: true` | — |
| 6. PR + Slack | one Haiku agent assembles and opens the PR; the main session sends the Slack DM | haiku |

Model and effort are fixed inside the script (`model:`/`effort:` per `agent()` call): Opus where a step *decides*, Sonnet where it *executes* a brief, Haiku only for text transforms and the gate. Do not override per run unless the user says so.

## 1. Resolve inputs

Dispatch **one Sonnet agent** (`subagent_type: general-purpose`, `model: sonnet`) with the ticket key and the repo name, instructed to:

1. Fetch the Jira ticket (Atlassian MCP `getJiraIssue`, including the Technical Design section, or `.scratch/<TICKET>/program-design.md` if the ticket points to it) and read the repo `CLAUDE.md`/README for test and typecheck commands.
2. **Resolve the working tree.** Follow the worktree convention in the repo's `CLAUDE.md` if it has one; otherwise default to a sibling worktree `../<repo>-wt-<TICKET>` (`git worktree add ../<repo>-wt-<TICKET> -b <branch> <base>`, then the repo's usual dependency install). Never build in the main checkout when other sessions may switch its branch. If a worktree for the ticket already exists, reuse it. `repo` in every later call is that path.
3. Write `.scratch/<TICKET>/lifecycle/brief.md` under `repo` (task text verbatim, acceptance criteria verbatim, the ADR paths the ticket names, test seams, surfaces, user-facing flows the ticket changes, branch per `feature/<TICKET>_desc` or `fix/<TICKET>_desc`, base branch, commands).
4. **Return only** JSON: `repo, briefPath, branch, base, seams[], proposedSeams[], openQuestions[], slices[], surfaces[], criteria[], testCmd, typecheckCmd`, and write the same JSON to `.scratch/<TICKET>/lifecycle/inputs.json` (pick-up mode reads it). `criteria` are the acceptance criteria as **verbatim strings in the ticket's order** — the scripts key them `C1..Cn` by position. `proposedSeams` is filled only when the ticket names no seams (public interface + behaviours to test there, as proposals for the user). `openQuestions` lists design decisions the ticket leaves open; empty when there are none.

`slices`: take them verbatim from the ticket's Technical Design "Build slices" list if present. Otherwise **default to one slice** (`{ name, scope, seams[] }` covering the whole ticket); split into 2–4 only when the ticket both crosses several layers *and* is clearly too large for one builder's context. A split is cut as **tracer bullets**: slice 1 is the thinnest happy path through every layer the ticket touches (real code, real tests), later slices widen it (edge cases, error paths, variants). Never one slice per layer or per seam group. A single-layer ticket is always one slice. A slice's `seams` is its focus, not a fence: builders may use any confirmed ticket seam. (Fallback slicing is a deliberate exception to "Opus decides": with one slice as the default there is rarely a decision to make, and a poor split costs build efficiency, not correctness — review, verify and the gate still see the whole diff.) `surfaces`: any of `web` (browser app), `ios` (mobile app), `portal` (server-rendered staff/admin UI), `api` (backend-only: API endpoints, server-only changes).

Never Read the ticket or the design docs into the main session.

**Seams gate.** `mattpocock-skills:tdd` only writes tests at pre-agreed seams. If `seams` is empty, relay the agent's `proposedSeams` and ask the user **once**; the confirmed list becomes `seams`. Do not run step 2 until they are confirmed. If `openQuestions` is non-empty, resolve them with the user first (`superpowers:brainstorming` if they are real design decisions) — never inside a builder.

## Paths

Workflow `scriptPath` and file paths passed to agents must be absolute. Resolve three values once, before step 2:
- `SKILL_DIR`: the base directory Claude Code printed when this skill loaded (e.g. `/Users/<you>/.claude/skills/task-lifecycle`).
- `SCOUT_SCRIPT`: `<SKILL_DIR>/reference/scout.sh` — the mechanical diff scout and security trigger that builders, fixers and the scout agent run. Passed as `scoutScript` to both stages.
- `STRUCTURE_SKILL` (optional): the absolute path of the `SKILL.md` of any strict maintainability-review skill you have installed (`$HOME/.claude/skills/<name>/SKILL.md`, expanded). If you have none, omit `structureSkill`: the structure review is then skipped and the script logs it.

## 2–3. Build and review

```
Workflow({ scriptPath: "<SKILL_DIR>/workflows/lifecycle.js",
           args: { stage: "build", ticket, repo, base, branch, briefPath, seams, slices, testCmd, typecheckCmd,
                   scoutScript: "<SCOUT_SCRIPT>", structureSkill: "<STRUCTURE_SKILL>" } })
```
Optional args: `maxFixRounds` (default 1), `builderEffort` (default `medium`), `structureMinLines` (default 150: below it the structure review is skipped), `attempt` (see Resuming).

What the script guarantees: builders test-first at the listed seams only, commit on green, and the last one runs `scout.sh` for the diff measurements and the mechanical security trigger (a missing or empty scout is re-measured by a Haiku scout agent, never trusted); round 1 reviews `base...HEAD` with correctness and spec (the ticket, `CONTEXT.md` and named ADRs against the diff), + structure above the line threshold, + security when the trigger fired; every later review is incremental on `REVIEWED_SHA..HEAD`; a correctness or security reviewer that dies blocks the run rather than counting as a clean review (a dead spec or structure reviewer is logged); CONFIRMED findings go straight to the fix builder in every round; PLAUSIBLE findings go to the Opus assessor in round 1 and to the PR body afterwards; low go to the PR body; structure findings whose remedy leaves the ticket's files are deferred. Builders and fixers record departures from the brief as `deviations`, which the spec reviewer passes through. `fixed` is what the fixer actually committed — items it returned as `unfixed`, or everything when it committed nothing, land in `knownNotFixed` with the reason. The last fix round is committed but re-reviewed by step 4's final review, not here (`result.unreviewedFix`). The result carries `headSha`, `reviewedSha`, `base`, `rounds`, `fixed`, `plausibleFixed`, `knownNotFixed`, `deferredOutOfScope`, `lowFindings`, `rejected`, `deviations`, `security.rounds`/`skippedReasons`.

**Gate check.** If `result.blocked` is set, stop and tell the user the stage and detail, then act on `blocked.resumable` (see Resuming): `needs_seam` → ask, add the seam, fresh run; a red suite or typecheck (`suitePassed`/`typecheckPassed` false) → the builder's work needs a fix, not a resume: tell the user; an environmental block, a dead agent or a dead reviewer → resume with `attempt`. Otherwise relay a 5-line summary (slices, rounds, found/fixed counts, security ran or skipped) and continue.

## 4–5. Verify and final review

```
Workflow({ scriptPath: "<SKILL_DIR>/workflows/lifecycle.js",
           args: { stage: "verify", ticket, repo, branch, base, briefPath, testCmd, typecheckCmd, seams,
                   headSha, reviewedSha, surfaces, criteria,
                   scoutScript: "<SCOUT_SCRIPT>", driversRef: "<SKILL_DIR>/reference/verify-drivers.md" } })
```
Optional: `skipVerify: true` (only after the user chose it), `fixBrief` (PR-comment text, pick-up mode), `maxVerifyRounds` (default 2), `verifyChunk` (default 4 criteria per verify agent), `attempt` (see Resuming). `criteria` must be plain strings and `surfaces` drawn from `web|ios|portal|api`; anything else is rejected before any agent runs.

The verify agents read `reference/verify-drivers.md` themselves (driver per surface, server-identity check, recording paths, dev-login, device-only rules) and append evidence to `.scratch/<TICKET>/lifecycle/verify-*.md` as they go. A criterion without evidence is a failure; a criterion once evidenced stays evidenced across re-verify rounds. A failing flow goes to a fix builder at once; a criterion the agent merely could not evidence is re-verified once before it can reach a fixer, so a reporting gap does not become a code change. Setup problems short-circuit as `blocked.stage == 'verify:setup'` — **never work around them, never fake a pass**; tell the user what is missing and wait, then resume with `attempt` (Resuming). Final review runs once, incremental, only if code changed since `reviewedSha`; its CONFIRMED findings are fixed and re-verified once (surfaces that recorded flows only), not re-reviewed, by design. The gate at the end is the one independent suite + typecheck run in the lifecycle. It is green only when both exit codes are 0, the tree has no uncommitted changes (untracked `.scratch/` and `.maestro/` excepted — the PR would not contain anything else), and it ran on the expected HEAD. A red or dirty gate is **not** resumable: a red suite needs a new fix; for a dirty tree remove the stray files, or if they belong in the PR re-run step 4 with `fixBrief: "commit <files>: <why>"` so a fixer commits them under the final review. Never commit them yourself and resume — the gate would run on a HEAD nobody reviewed.

## 6. Open PR + report

Merge the two results. Dispatch **one Haiku agent** with the merged JSON and the repo path to: fill `.github/PULL_REQUEST_TEMPLATE.md` if present (tick honestly; every claim about what the code does — "guarded", "tested", "no-op", "already handled" — must name the file or test that shows it in `git diff <base>...HEAD`, and a claim it cannot point to is left out), include the acceptance-criteria evidence checklist, "Deviations from the ticket" (`deviations` from both stages, verbatim), "Known findings not fixed" (`knownNotFixed`, `unreviewedFix` noted), "Suggested follow-up (out of scope)" (`deferredOutOfScope`), "Known low-severity findings (not fixed)", and the `Security review: ran in rounds …` or `skipped — <trigger reason>` line; push, then `gh pr create --base <base> --head <branch>` — unless `gh pr view <branch>` already finds a PR (pick-up mode), in which case push and post the summary as a PR comment; return `{ prUrl, slackText }`. Verify status does **not** go in the PR. The known-low, deviations and known-not-fixed sections come from the merged result and are never removed or shortened when the body is edited by hand.

Then, if the Slack MCP is configured, the main session sends **one Slack DM** (`slack_search_users` → `user_id` as `channel_id`, `slack_send_message`) — every run when Slack is available — carrying: the PR link; visual-verification status per surface with recording paths, or an explicit "⚠️ visual test NOT run — <reason>" (setup skip, device-only feature); each `plausibleFixed` finding with one sentence on why it mattered; and, when `deviations` is non-empty, one line: "ticket needs amending". The Slack MCP is text-only: post paths, never claim an attachment.

## Resuming

`resumeFromRunId` replays every agent whose prompt is unchanged — including the one that returned the block, because a `setup_failure` or `blocked` is a completed result and is cached like any other. Resuming with the same args therefore hands back the same block instantly. Every `blocked` result says what to do:

- `resumable: true` (environment problem, dead agent, dead reviewer, gate on the wrong HEAD) → fix the environment, then `Workflow({ scriptPath, args: { ...<same args>, attempt: <previous attempt + 1> }, resumeFromRunId })`. `attempt` is embedded only in the builder, verify-unit and gate prompts, so a preceding PR-comments fixer stays cached and those agents and everything after them run live.
- `resumable: false` → do not resume. `needs_seam`: add the seam and start a fresh run (every builder prompt changes). Red suite or typecheck, a fixer that committed nothing, `verify:cap`, a red or dirty gate: tell the user; the next step is a decision or a new fix dispatch, not a replay.

Changing any other arg (new seams, `skipVerify`) invalidates the cache from the first prompt that embeds it, which is usually everything — expect a fresh run in that case.

## Picking a task back up (PR comments)

No PR monitoring — the run ends after the Slack DM. On comments, in a fresh session: dispatch **one Haiku agent** to return the JSON in `<repo>/.scratch/<TICKET>/lifecycle/inputs.json` (written by step 1; if the worktree is gone, run step 1 again) plus the PR head from `gh pr view <branch> --json headRefOid`. Set `reviewedSha` = `headSha` = that head, run step 4 with `fixBrief` = the comments verbatim, then step 6 (push + comment on the PR).

## Red flags — you left the skill

- Reading the ticket, design docs, or a diff into the main session instead of through an agent
- Editing source, running the suite, or driving a browser inline
- Building in the main checkout instead of the ticket worktree
- Changing a `model:`/`effort:` in a dispatch or script without the user asking
- Re-running step 2 after step 4, or re-entering the review loop after the final review
- Running step 4 with `skipVerify` before the user chose it, or a Slack DM that hides a skipped visual test
- Opening the PR on a `blocked` result, or "fixing" a red gate
- Dispatching builders before seams are confirmed
- Resuming a blocked stage without bumping `attempt`, or resuming a `resumable: false` block
- Committing stray files yourself to clear a dirty gate
- Using `fork` for any lifecycle agent (it copies the whole session context)
