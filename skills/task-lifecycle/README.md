# task-lifecycle — how the Workflow version works

`SKILL.md` is what Claude follows. This file explains what the scripts do, what they assume about the Workflow runtime, and the design lessons behind them.

## Layout

```
task-lifecycle/
  SKILL.md                       # the skill: inputs, stages, gates, resuming
  workflows/lifecycle.js         # one script, two stages: args.stage = "build" | "verify"
  workflows/probe.js             # one-agent capability probe
  workflows/test/run.mjs         # stub harness: node workflows/test/run.mjs
  reference/scout.sh             # diff scout + mechanical security trigger (source of truth for the regexes)
  reference/security-triggers.md # human-readable copy of the trigger
  reference/verify-drivers.md    # read only by verify agents
  reference/review-checklist.md  # read by the correctness reviewer
```

Run the harness after every `lifecycle.js` or `scout.sh` edit. It replaces `agent()` with scripted responders and asserts the routing the script owns: blocks, resume flags, fix accounting, verify gap-vs-fix, final review, gate verdict, and the scout trigger files.

## Stages

1. **Resolve inputs** (one agent, outside the script): ticket and repo go in; a brief file, seams, slices, surfaces, criteria and commands come out.
2. **Build** (`stage: "build"`): one builder per slice, test-first at the agreed seams; the last one runs `scout.sh`. Round 1 reviews `base...HEAD` with a correctness reviewer, a spec reviewer, a structure reviewer above a line threshold, and a security reviewer when the trigger fired. Later rounds are incremental on `REVIEWED_SHA..HEAD`. CONFIRMED findings go to a fix builder; PLAUSIBLE ones go to an assessor in round 1 and to the PR body after that.
3. **Verify** (`stage: "verify"`): one agent per surface and group of up to four criteria drives the running app and appends evidence to a file; failing flows are fixed (capped); one incremental final review runs if code changed; a gate agent runs the suite and typecheck once more.
4. **PR** (outside the script): one agent writes the PR body from the merged results.

## Agent budget per run (typical ticket, 1-2 slices, 1 fix round)

| Stage | Agents | Of which Opus |
|---|---|---|
| Step 1 brief | 1 Sonnet | 0 |
| Build: slices | 1-4 Sonnet | 0 |
| Build: review r1 | 2-4 Opus (correctness + spec; + structure above the line threshold; + security if fired) | 2-4 |
| Build: assess (PLAUSIBLE only, r1 only) | 0-1 Opus | 0-1 |
| Build: fix r1 | 0-1 Sonnet | 0 |
| Build: review r2 | 1-2 Opus (incremental, medium effort) | 1-2 |
| Build: fix r2 (re-reviewed by the final review) | 0-1 Sonnet | 0 |
| Verify | 1-4 Sonnet | 0 |
| Verify fixes and re-verify | 0-2 + 0-4 Sonnet | 0 |
| Final review | 0-2 Opus (only if code changed since `REVIEWED_SHA`) | 0-2 |
| Gate | 1 Haiku | 0 |
| PR | 1 Haiku | 0 |

Opus is used where a step decides, Sonnet where it executes a brief, Haiku only for text transforms and the gate.

## What the probe tells you

`workflows/probe.js` runs one Haiku agent that reports what a workflow subagent can reach. Run it once before adopting the scripts and again after a harness upgrade:

```
Workflow({ scriptPath: "<SKILL_DIR>/workflows/probe.js" })
```

Facts it established, and the standing constraints they impose on anything added to the scripts:

- Workflow subagents can call the `Skill` tool, so "invoke the X skill by name" sentences work inside agents. If `hasSkillTool` is ever false, those sentences must become the skill's recipe inline.
- They have **no `Agent` tool**: built-in review skills that fan out through subagents cannot run inside a workflow, so fan-out belongs in the script.
- They have no `AskUserQuestion`: every decision is made before a stage starts or returned in the result. That is why the seams gate lives in the main session.
- The bundled `verify` skill is not model-invocable, so no agent may invoke it. The verify agents follow `reference/verify-drivers.md` instead.
- MCP tools load through ToolSearch only if the servers are enabled in the project. A server listed as both enabled and disabled is disabled; check settings before blaming the harness.

## Per-repo security trigger

`scout.sh` ships generic path and content triggers. A repo adds its own with two optional files, read from the repo under review:

- `.claude/security-trigger-paths`: one path substring per line.
- `.claude/security-trigger-regex`: extended regular expressions, OR-ed into the server-side content regex.

Blank lines and `#` comments are ignored. An invalid regex file fires the trigger with a `config:` reason rather than silencing it. See `reference/security-triggers.md`.

## Design notes

- **State lives in the script, not the orchestrator.** `REVIEWED_SHA`, round counters, severity and verdict routing, the scope guard and evidence merging are plain JS. An LLM orchestrator holding them compacts mid-run and loses them.
- **Reviewers are owned by the script.** One owner per question, incremental re-reviews at lower effort. A reviewer that dies must block the run: a null output treated as "no findings" opens PRs that were never reviewed.
- **A fix loop cap of 1 is enough.** CONFIRMED findings are fixed every round, PLAUSIBLE ones are assessed once and then reported, and the last fix is covered by the final review.
- **The security trigger is mechanical.** Bare words like `auth|session|token` match almost every file and make the review run every round. Match definitions and sinks in server-side code, a short list of client sinks, and sensitive words near log calls; never ask an agent to judge "when unsure, fire".
- **`grep -v '^\+\+\+'` is invalid BRE on macOS.** BSD grep exits 2 and prints nothing, and ugrep rejects it too, so content triggers silently never run. Use `grep -Ev '^\+\+\+'` as in `scout.sh`, and call `/usr/bin/grep` so an aliased `grep` cannot change the behaviour.
- **Never trust a missing measurement.** A builder that returns no scout output is re-measured by a Haiku scout agent; otherwise the structure and security reviews switch off silently.
- **The test gate runs each command to a log and reports `EXIT=`, judged in JS.** Piping the suite through `tail` makes the exit code `tail`'s, and letting a model judge green from the text is unreliable. The gate also reports `git status --porcelain` (taken before the tests) and HEAD, and `judgeGate` requires both exit codes 0, no uncommitted change outside untracked scratch directories, and HEAD matching the expected SHA, so code that was never committed cannot pass.
- **Resume replays completed results, including blocks.** A `setup_failure` or `blocked` return is a completed result and is cached like any other, so resuming with the same args hands back the same block. The `attempt` arg is embedded only in the builder, verify-unit and gate prompts, so those and everything after them re-run while earlier agents stay cached. Every `blocked` states whether it is `resumable`.
- **"Commit the stray files and resume" can never pass the gate.** Committing moves HEAD past the SHA the gate expects and ships code nobody reviewed. Remove the files, or route them through a `fixBrief` so a fixer commits them under the final review.
- **Criteria carry ids.** Agents echo criteria loosely (dropped full stops, changed quotes), so matching on exact text marks every criterion missing. Criteria are keyed `C1..Cn` by position, matched leniently on the id, with normalised text as a fallback; ambiguous text never matches. Seed the evidence map with every criterion so none drops off the PR checklist.
- **`fixed` is what the fixer committed.** Fixers return an `unfixed` list with reasons; everything else is "fixed". A fixer that commits nothing ends the loop with all findings reported and no empty-range review.
- **A criterion the agent could not evidence is not a code defect.** A failing flow goes to a fixer at once; a `missing` criterion is re-verified before it can reach a fixer, so a reporting gap does not become a code change.
- **Slices are tracer bullets.** Slice 1 is the thinnest happy path through every layer and includes one test at the outermost seam; later slices widen it. A slice's seams are its focus, not a fence. With no slice list, default to one slice: splitting is the exception.
- **Calibrate severity explicitly.** Low is cosmetic only; a defect a user or caller can reach, or a test that pins behaviour the brief rules out, is medium at least; a repo-wide convention is a note.
- **Ask for the test that fails when the guard is deleted.** Round 1 only, so the rule cannot chain into unreviewed fix commits. A spec finding for "behaviour the ticket did not ask for" is always PLAUSIBLE so the assessor checks it before anything is removed.
- **Dedupe findings on file, line and normalised summary, not owner.** Two issues on one line must both survive.
- **Record departures from the brief as `deviations`.** Builders and fixers return them, both stages aggregate them, and the PR body prints them verbatim.
- **Compare new pages with an existing neighbour.** Browser-default controls or missing styles are a failing `appearance: <page>` flow.
- **Recordings go under `.scratch/<TICKET>/lifecycle/`.** A video directory shared by every session on the machine is a cross-session race, and files anywhere else in the repo fail the gate as uncommitted.
- **Validate args before any agent runs.** Criteria objects become `[object Object]` and silently match nothing.
- **Known gaps (verify stage).** Evidence is sticky, so the post-final re-verify catches only flow failures, not a criterion the final fix broke. Every surface is asked to evidence every criterion, which duplicates work with several surfaces. Flows are keyed by the name the agent returns, so renamed flows pile up in the report.
