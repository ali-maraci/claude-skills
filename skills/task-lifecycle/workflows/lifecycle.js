export const meta = {
  name: 'task-lifecycle',
  description: 'Task lifecycle stage runner. args.stage = "build" (slices → review → route → fix) or "verify" (verify → fix → final review → gate).',
  phases: [
    { title: 'Build', detail: 'one fresh Sonnet builder per slice; the last one also runs the diff scout for the range', model: 'sonnet' },
    { title: 'Review', detail: 'Opus reviewers in parallel, one owner per question (spec in round 1 only)', model: 'opus' },
    { title: 'Fix', detail: 'JS routes findings; Opus assesses PLAUSIBLE ones in round 1 only; Sonnet fixes and re-scouts', model: 'sonnet' },
    { title: 'Verify', detail: 'Sonnet verify agents, one per surface × criteria chunk, Playwright or Maestro', model: 'sonnet' },
    { title: 'Final review', detail: 'incremental Opus review only if code changed since REVIEWED_SHA', model: 'opus' },
    { title: 'Gate', detail: 'the one independent suite + typecheck run on final HEAD; exit codes, a clean tree and the expected HEAD decide', model: 'haiku' },
  ],
}

// ---------------------------------------------------------------------------
// args contract (set by the orchestrator from the brief; see SKILL.md)
// common:  stage 'build'|'verify', ticket, repo (the ticket worktree), base, branch, briefPath,
//          seams[] (non-empty, pre-confirmed), testCmd, typecheckCmd,
//          scoutScript (abs path of reference/scout.sh — the mechanical diff scout + security trigger),
//          attempt=1 (bump to N+1 together with resumeFromRunId after a `blocked.resumable` result: it changes
//          only the builder, verify-unit and gate prompts, so cached agents before them are kept)
// build:   slices[{name, scope, seams[]}] (1..4), maxFixRounds=1, builderEffort='medium',
//          structureMinLines=150, structureSkill? (abs path of a maintainability-review skill's SKILL.md; unset → no structure review)
// verify:  headSha, reviewedSha (from the build result, or PR head when picking up comments),
//          surfaces[] of 'web'|'ios'|'portal'|'api', criteria[] verbatim strings in stable order, driversRef (abs path),
//          fixBrief? (PR comments), skipVerify=false (only after the user chose it),
//          maxVerifyRounds=2, verifyChunk=4
// result.deviations: builders' and fixers' declared departures from the brief (empty list when none).
// result.blocked: { stage, detail, resumable, ... }. resumable=true → same args + attempt+1 + resumeFromRunId.
//          false (needs_seam, red suite/typecheck, verify:cap, a fixer that committed nothing, dirty or red gate) → see SKILL.md.
// ---------------------------------------------------------------------------
const A = args || {}
const need = (keys) => { for (const k of keys) if (A[k] === undefined || A[k] === null || A[k] === '') throw new Error(`args.${k} is required`) }
need(['stage', 'ticket', 'repo', 'base', 'branch', 'briefPath', 'seams', 'testCmd', 'typecheckCmd', 'scoutScript'])
if (!Array.isArray(A.seams) || A.seams.length === 0) throw new Error('args.seams must be a non-empty list (seams gate)')
if (A.stage !== 'build' && A.stage !== 'verify') throw new Error('args.stage must be "build" or "verify"')
const ATTEMPT = Number(A.attempt) > 1 ? ` [attempt ${Number(A.attempt)}]` : ''

// --------------------------- schemas ---------------------------------------
const SCOUT_PROPS = {
  diffLines: { type: 'integer' }, files: { type: 'array', items: { type: 'string' } },
  securityFired: { type: 'boolean' }, securityReasons: { type: 'array', items: { type: 'string' } },
}
const SCOUT = { type: 'object', required: Object.keys(SCOUT_PROPS), properties: { ...SCOUT_PROPS, headSha: { type: 'string' } } }

const FINDING = {
  type: 'object',
  required: ['file', 'severity', 'verdict', 'summary', 'failure_scenario'],
  properties: {
    file: { type: 'string' }, line: { type: 'integer' },
    severity: { type: 'string', enum: ['high', 'medium', 'low'] },
    verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE'] },
    summary: { type: 'string' }, failure_scenario: { type: 'string' },
    remedy: { type: 'string' },
    files_touched_by_remedy: { type: 'array', items: { type: 'string' } },
    owner: { type: 'string' },
  },
}
const FINDINGS = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: FINDING }, notes: { type: 'string' } } }

const REJECTED = { type: 'object', required: ['summary', 'reason'], properties: { file: { type: 'string' }, line: { type: 'integer' }, summary: { type: 'string' }, reason: { type: 'string' } } }

const DEVIATION = { type: 'object', required: ['requirement', 'instead', 'why'], properties: { requirement: { type: 'string' }, instead: { type: 'string' }, why: { type: 'string' } } }

const BUILD = {
  type: 'object',
  required: ['status', 'headSha', 'suitePassed', 'typecheckPassed', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'needs_seam', 'blocked'] },
    headSha: { type: 'string' }, suitePassed: { type: 'boolean' }, typecheckPassed: { type: 'boolean' },
    testsAdded: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    notesForNextSlice: { type: 'string' },
    summary: { type: 'string' }, detail: { type: 'string' },
    scout: SCOUT,   // optional: only the last slice's builder and the fixers run the scout
    deviations: { type: 'array', items: DEVIATION },
  },
}
// A fixer is a builder that also says what it could NOT fix.
const FIX = { ...BUILD, properties: { ...BUILD.properties, unfixed: { type: 'array', items: REJECTED } } }

const ASSESS = { type: 'object', required: ['toFix', 'rejected', 'deferred'], properties: { toFix: { type: 'array', items: FINDING }, rejected: { type: 'array', items: REJECTED }, deferred: { type: 'array', items: REJECTED } } }
const GATE = { type: 'object', required: ['headSha', 'porcelain', 'testExit', 'typecheckExit', 'summary'], properties: { headSha: { type: 'string' }, porcelain: { type: 'array', items: { type: 'string' } }, testExit: { type: 'integer' }, typecheckExit: { type: 'integer' }, summary: { type: 'string' } } }

const VERIFY = {
  type: 'object',
  required: ['status', 'surface', 'flows', 'criteria'],
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'setup_failure'] },
    surface: { type: 'string' },
    setupDetail: { type: 'string' },
    evidenceFile: { type: 'string' },
    flows: { type: 'array', items: { type: 'object', required: ['name', 'status', 'evidence'], properties: { name: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail', 'device_only'] }, evidence: { type: 'string' }, recordingPath: { type: 'string' }, failure: { type: 'string' } } } },
    criteria: { type: 'array', items: { type: 'object', required: ['id', 'status', 'evidence'], properties: { id: { type: 'string' }, criterion: { type: 'string' }, status: { type: 'string', enum: ['evidenced', 'missing', 'device_only'] }, evidence: { type: 'string' } } } },
  },
}

// --------------------------- diff scout ------------------------------------
// The measurement and the security trigger are mechanical and live in reference/scout.sh (the source of
// truth for the regexes and path list). Agents run it and copy its output; they transcribe no regex.
const scoutSteps = range => `Then, READ-ONLY, run \`bash ${A.scoutScript} ${A.repo} ${range}\` once and copy its output into "scout" exactly as printed: files = the "F:" lines, diffLines = DIFF_LINES, securityFired = FIRED, securityReasons = the "REASON:" lines without that prefix. Do not re-run it with other flags and make no judgement calls. If you are blocked before committing, leave "scout" unset.`

// --------------------------- helpers ---------------------------------------
const norm = p => String(p || '').replace(A.repo + '/', '').replace(/^\.\//, '')
const inScope = (p, touched) => { const q = norm(p); return touched.some(t => { const u = norm(t); return u === q || u.endsWith('/' + q) || q.endsWith('/' + u) }) }
// One owner can raise two issues on one line, and two owners on one line usually mean different things: key on the summary too.
const key = f => `${norm(f.file)}:${f.line ?? '-'}|${normText(f.summary)}`
function dedupeRound(findings) { const seen = new Set(); const out = []; for (const f of findings) { const k = key(f); if (seen.has(k)) continue; seen.add(k); out.push(f) } return out }
const slim = f => ({ file: f.file, line: f.line, severity: f.severity, verdict: f.verdict, owner: f.owner, summary: f.summary })
const loc = f => `${f.file}${f.line ? ':' + f.line : ''}`
const fmt = f => `- [${f.owner || 'review'} · ${f.severity} · ${f.verdict}] ${loc(f)} — ${f.summary}\n  Failure scenario: ${f.failure_scenario}${f.remedy ? `\n  Proposed remedy: ${f.remedy}` : ''}`
const chunk = (arr, n) => { if (!arr.length) return [[]]; const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
const failedBuild = f => !f || f.status !== 'done' || !f.suitePassed || !f.typecheckPassed
const sameSha = (a, b) => { const x = String(a || '').trim(), y = String(b || '').trim(); return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x)) }
// Verify agents echo criteria loosely (trailing full stops dropped → every criterion "missing" → verify:cap).
// Match by the id we hand out ("C3"), falling back to normalised text; never by exact text.
const normText = s => String(s || '').normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/, '').toLowerCase()
const parseId = s => { const m = /^\[?c?(\d+)\]?\.?$/i.exec(String(s || '').trim()); return m ? 'C' + m[1] : null }

// A builder/fixer result that is not a clean `done` becomes a blocked record. A red suite or typecheck is a
// `done` that needs a new fix, not a resume; needs_seam changes every builder prompt, so it is a fresh run.
function blockRecord(b, extra) {
  const died = !b
  return {
    ...extra,
    status: died ? 'died' : b.status,
    suitePassed: died ? undefined : b.suitePassed, typecheckPassed: died ? undefined : b.typecheckPassed,
    detail: died ? 'agent skipped or died' : (b.detail || b.summary),
    resumable: died || b.status === 'blocked',
  }
}
// What a fixer actually fixed: everything it was given minus what it returned as `unfixed`. An unfixed entry
// matches by summary, narrowed by file + line when the summary is shared (e.g. "untested guard"); only when its summary
// matches nothing (paraphrased) does it fall back to file + line alone.
function splitFixed(toFix, f) {
  const unfixed = Array.isArray(f.unfixed) ? f.unfixed : []
  const reason = new Map()
  for (const u of unfixed) {
    const at = x => norm(u.file) === norm(x.file) && (u.line == null || u.line === x.line)
    let hits = toFix.filter(x => normText(u.summary) === normText(x.summary))
    if (hits.length > 1 && u.file && hits.some(at)) hits = hits.filter(at)
    if (!hits.length && u.file) hits = toFix.filter(at)
    for (const x of hits) if (!reason.has(x)) reason.set(x, u.reason || 'fixer left it')
  }
  return { fixed: toFix.filter(x => !reason.has(x)), notFixed: toFix.filter(x => reason.has(x)).map(x => ({ ...slim(x), reason: reason.get(x) })) }
}

// Deterministic routing.
// low → PR body. structure finding whose remedy leaves the ticket's files → deferred.
// CONFIRMED (medium/high) → fix directly, every round. PLAUSIBLE → assessor in round 1, PR body ("known") from round 2.
function route(findings, round, touched) {
  const direct = [], toAssess = [], low = [], known = [], outOfScope = []
  for (const f of findings) {
    if (f.severity === 'low') { low.push(f); continue }
    if (f.owner === 'structure') {
      const remedyFiles = (f.files_touched_by_remedy && f.files_touched_by_remedy.length) ? f.files_touched_by_remedy : [f.file]
      if (remedyFiles.some(p => !inScope(p, touched))) { outOfScope.push(f); continue }
    }
    if (f.verdict === 'CONFIRMED') { direct.push(f); continue }
    if (round > 1) known.push(f); else toAssess.push(f)
  }
  return { direct, toAssess, low, known, outOfScope }
}

// --------------------------- shared brief fragments -------------------------
const HYGIENE = `Context hygiene (non-negotiable): grep before you Read; Read with offset/limit, never a whole file over 200 lines; run only the single affected test file while iterating, with the quietest reporter available (dot/quiet) piped through \`tail -40\`; typecheck output through \`tail -30\`. Commit only when the full suite and typecheck are green.`
// focus = the slice's own seams; every other ticket seam stays usable, so a slice list cut too narrow cannot block a builder.
const seamsBlock = (focus = A.seams) => {
  const list = xs => xs.map(s => `- ${s}`).join('\n')
  const extra = A.seams.filter(s => !focus.includes(s))
  return `Test seams (pre-confirmed by the user — do not ask, do not add others)${extra.length ? '. This slice tests at:' : ':'}\n${list(focus)}${extra.length ? `\nAlso confirmed for this ticket — use one only where this slice's path genuinely crosses it:\n${list(extra)}` : ''}\nIf you need a seam outside ${extra.length ? 'both lists' : 'this list'}, STOP, commit nothing further, and return status "needs_seam" with the seam you need in detail.`
}
const DEVIATE = `If you depart from the brief or an ADR it names, record each departure under "deviations" (the requirement quoted, what the code does instead, why) — never depart silently.`
const SEVERITY = `Severity calibration: low is cosmetic only; a defect a user or caller can reach (data loss, an uncapped or unvalidated input, a wrong status code, a missing check on an identity or personal-data path), or a test that pins behaviour the brief or an ADR rules out, is medium at least; a behaviour the repo applies everywhere on purpose is a note (put it in notes), not a finding.`
// The review checklist file sits next to scout.sh in reference/.
const CHECKLIST = A.scoutScript.replace(/scout\.sh$/, 'review-checklist.md')
const UNTESTED_GUARD =`grep the tests and name the one that fails if that line is deleted; where none exists, report a medium "untested guard" finding whose remedy is the test to write, verdict CONFIRMED since you looked`
const fmtDeviations = ds => ds.length ? ds.map(d => `- "${d.requirement}" → ${d.instead} (why: ${d.why})`).join('\n') : '- (none declared)'
const FINISH = `Finish with the full suite (\`${A.testCmd}\`) and typecheck (\`${A.typecheckCmd}\`) once, commit on green with a message prefixed "${A.ticket}: ", and return the structured result (headSha = the full 40-character output of \`git rev-parse HEAD\` after your commit; filesTouched = files you changed). If something environmental blocks you (no DB, missing env), return status "blocked" with what is missing — do not work around it.`

// --------------------------- agents ----------------------------------------
function buildSlice(slice, i, n, prev) {
  const seams = (slice.seams && slice.seams.length) ? slice.seams : A.seams
  const last = i + 1 === n
  return agent(`You are the BUILDER for ${A.ticket}, slice ${i + 1} of ${n}: "${slice.name}". Repo: ${A.repo}. Branch: ${A.branch} (create from ${A.base} if it does not exist; otherwise continue on it — do NOT reset or rebase it).
Read the brief at ${A.briefPath} once (task text, acceptance criteria, commands). ${prev ? `Previous slices already landed — do not rediscover them; build on what they made rather than rebuilding it:\n${prev}` : n > 1 ? `This is the first of ${n} slices. If the slice scope below spans several layers, it is the tracer bullet: make the thinnest happy path work end to end through those layers with real code, and include at least one test at the outermost seam you are given that drives that path through every one of them (per-layer tests alone do not prove the path); leave edge cases and variants to the later slices. If the scope names a single layer, build only that layer. Either way the slice scope is the boundary — never build work that belongs to a later slice.` : 'This is the only slice.'}
Slice scope: ${slice.scope}
Work test-first via the \`mattpocock-skills:tdd\` skill: red → green, one cycle at a time (one failing test → minimal code → repeat). No refactor step — restructuring comes from review. Pure config/copy/markup with no testable behaviour is the only exception to test-first — say so in summary instead of inventing a test.
${seamsBlock(seams)}
${HYGIENE}
${FINISH}
${DEVIATE}
${!last ? 'Set notesForNextSlice to the 3–6 facts the next slice needs (files, exported names, decisions) so it does not re-read what you read. Do not run the diff scout; leave "scout" unset.' : scoutSteps(`${A.base}...HEAD`)}${ATTEMPT}`,
  { label: `build:${slice.name}`, phase: 'Build', model: 'sonnet', effort: A.builderEffort || 'medium', schema: BUILD })
}

function fixer(label, body, scoutRange) {
  return agent(`You are the FIX BUILDER for ${A.ticket} in ${A.repo} on branch ${A.branch} (continue on it; never reset or rebase). Fix EXACTLY what is listed below and nothing else — no restructures beyond the stated remedy, no drive-by cleanups. Test-first via the \`mattpocock-skills:tdd\` skill: where the item is testable behaviour, write a failing test that reproduces it, then fix. ${seamsBlock(A.seams)}
${HYGIENE}
${FINISH} If an item cannot be fixed as stated, leave it and list it under "unfixed" with its summary copied verbatim and a one-line reason; if you end up committing nothing, say so in summary. ${DEVIATE}

${body}

${scoutSteps(scoutRange)}`, { label, phase: 'Fix', model: 'sonnet', effort: 'medium', schema: FIX })
}

function scoutAgent(range, label) {
  return agent(`You are a read-only diff scout in ${A.repo}. Do not edit anything. Run \`bash ${A.scoutScript} ${A.repo} ${range}\` once and copy its output into the structured result exactly as printed: headSha = HEAD_SHA, files = the "F:" lines, diffLines = DIFF_LINES, securityFired = FIRED, securityReasons = the "REASON:" lines without that prefix. Do not re-run it with other flags and make no judgement calls.`,
    { label, phase: 'Final review', model: 'haiku', effort: 'low', schema: SCOUT })
}
// Builders before the last slice skip the scout; a `done` with no usable scout is measured independently
// rather than trusted (a lazy zero would silently switch off the structure and security reviews).
async function ensureScout(b, range, label) {
  if (b.scout && Array.isArray(b.scout.files) && b.scout.files.length) return b.scout
  log(`${label}: no usable scout in the result — measuring ${range} with a scout agent`)
  return scoutAgent(range, `scout:${label}`)
}

function reviewCorrectness(range, level, effort, round, labelPrefix) {
  const incremental = round > 1
  return agent(`You are the CORRECTNESS reviewer (read-only: do not edit, commit, or run formatters) for ${A.ticket} in ${A.repo}. Review ONLY \`git diff ${range}\`${incremental ? ' — an incremental re-review of fixes; check the fixes are correct, do not re-litigate design or raise findings about unchanged code' : ''}. You may open surrounding files for context (grep first, Read with offset/limit).
Do one careful pass of the whole diff, then a second pass hunting only for: wrong branch/boundary conditions, unhandled null/empty/error paths, broken contracts between changed call sites, concurrency/ordering, personal data written without the project's audit helpers (if it has them), secrets or personal data in logs. In that second pass, for every guard, cap, lock, permission check, same-origin check or error branch the diff adds, ${incremental ? 'check it is correct; do not ask for tests for guards a fix added' : UNTESTED_GUARD}. Then apply the project rules in the repo's CLAUDE.md, read ${CHECKLIST} and apply ${incremental ? 'only items 1, 3, 4 and 8 (the classes a fix commit breaks) to the fix diff' : 'every item that applies to this repo'}; report each miss as a finding like any other. Level ${level}: ${level === 'medium' ? 'report only findings you are confident about' : 'broad coverage; include PLAUSIBLE findings with an explicit failure scenario'}.
Every finding needs file (and line where one applies), severity (high = wrong behaviour or data/safety risk; medium = real bug in an edge path; low = cosmetic only), verdict (CONFIRMED = you traced the failure; PLAUSIBLE = likely but not traced), a concrete failure scenario, and a one-line remedy. Reuse/efficiency/style notes are low unless they change behaviour. ${SEVERITY} No findings is a valid result.`,
  { label: `${labelPrefix}correctness`, phase: incremental && labelPrefix === 'final:' ? 'Final review' : 'Review', model: 'opus', effort, schema: FINDINGS })
}

function reviewStructure(range, effort) {
  return agent(`You are the STRUCTURE reviewer (read-only) for ${A.ticket} in ${A.repo}. Read ${A.structureSkill} and follow it on \`git diff ${range}\`. Hard cap: at most 5 findings, highest-conviction first, high/medium only — no cosmetic notes. high = one of the skill's presumptive blockers (missed code-judo deletion, file pushed past 1k lines, ad-hoc branching tangling an existing flow, feature checks scattered through shared code, needless wrapper/cast contract, duplicated helper or wrong layer); medium = any other structural/boundary/decomposition finding. For each, give file (line optional), the problem, the proposed remedy, and files_touched_by_remedy as repo-relative paths (every file the restructure would edit — this decides whether it is in scope). Use verdict CONFIRMED when the remedy is mechanical and behaviour-preserving, PLAUSIBLE otherwise.`,
  { label: 'review:structure', phase: 'Review', model: 'opus', effort, schema: FINDINGS })
}

function reviewSpec(range, deviations) {
  return agent(`You are the SPEC reviewer (read-only: do not edit, commit, or run formatters) for ${A.ticket} in ${A.repo}. Read the brief at ${A.briefPath} (task text, acceptance criteria, corrections, the ADR paths the ticket names), then \`CONTEXT.md\` at the repo root if it exists, then each ADR the brief lists; the repo's CLAUDE.md is already in your context. Walk the task text clause by clause against \`git diff ${range}\` (grep first, Read with offset/limit) and report: requirements missing or only partly built; requirements implemented differently without a declared deviation; behaviour the ticket did not ask for; breaches of a written rule (CLAUDE.md, CONTEXT.md, an ADR), citing the rule.
The builders declared these deviations — pass them through, never report them:
${fmtDeviations(deviations)}
Severity: a missing or wrong acceptance criterion is high; any other missing requirement or undeclared deviation is medium; a rule breach is medium; a judgement call is low. Every finding needs file (where the requirement is or belongs; line where one applies), verdict (CONFIRMED = you checked the clause against the code; PLAUSIBLE = likely but not checked; "behaviour the ticket did not ask for" is always PLAUSIBLE, so the assessor decides whether it is a legitimate guard before anything is removed), a failure scenario (what the ticket asks and what the code does instead), and a one-line remedy. No findings is a valid result.`,
  { label: 'review:spec', phase: 'Review', model: 'opus', effort: 'medium', schema: FINDINGS })
}

function reviewSecurity(range, level, effort, reasons, round, labelPrefix) {
  return agent(`You are the SECURITY reviewer (read-only) for ${A.ticket} in ${A.repo}. Review ONLY \`git diff ${range}\`${round > 1 ? ' (incremental: fixes only)' : ''}. The trigger fired because: ${reasons.slice(0, 12).join('; ')}.
Check, in this order: authn/authz on every changed or added endpoint and server action; personal-data reads/writes going through the project's audit helpers if it has them (never a raw insert into an audit table); nothing logging session tokens, pin, password, secret, authorization or personal-data fields; input validation and SQL/command construction on changed sinks; webhook signature/idempotency; CORS/CSP/cookie flags; secrets or keys in code or config; LLM calls on sensitive paths using only the project's approved provider; new/bumped dependencies. Apply the project rules in the repo's CLAUDE.md and ${CHECKLIST}. Level ${level}: ${level === 'medium' ? 'confident findings only' : 'broad coverage with explicit failure scenarios'}.
${round > 1 ? '' : `For each guard you confirm, ${UNTESTED_GUARD}.\n`}Severity: high = exploitable or a compliance breach; medium = weakness needing a second condition. ${SEVERITY} Verdict CONFIRMED only if you traced the path. No findings is a valid result.`,
  { label: `${labelPrefix}security`, phase: labelPrefix === 'final:' ? 'Final review' : 'Review', model: 'opus', effort, schema: FINDINGS })
}

function assess(findings, touched) {
  return agent(`You are the ASSESSOR for ${A.ticket} in ${A.repo}. Every finding below is PLAUSIBLE (the reviewer did not trace it). Run the \`superpowers:receiving-code-review\` skill over them: verify each against the code (and, where it cites the ticket or a written rule, against the brief at ${A.briefPath}) with technical rigor (open the cited code — grep first, Read with offset/limit), not blind agreement, and decide fix / reject / defer. De-duplicate findings two reviewers raised about the same code. Scope guard: a "structure" finding is accepted only if every file its remedy touches is in the ticket's diff (${touched.map(norm).join(', ')}); anything wider is DEFERRED with reason "out of ticket scope".
Return toFix with file, line, summary, failure_scenario, remedy copied verbatim and owner preserved; set verdict CONFIRMED only if you traced the failure yourself, else leave PLAUSIBLE. One-line reason per rejected/deferred item.

Findings:
${findings.map(fmt).join('\n')}`,
  { label: 'assess', phase: 'Fix', model: 'opus', effort: 'high', schema: ASSESS })
}

function verifyUnit(u, onlyFlows, onlyCriteria) {
  const criteria = onlyCriteria || u.criteria
  return agent(`You are the VERIFY agent for ${A.ticket} (surface: ${u.surface}${u.total > 1 ? `, criteria group ${u.idx + 1} of ${u.total}` : ''}) in ${A.repo}. Read ${A.driversRef} first — it names the driver for this surface, the prerequisites, the server-identity check, how recordings are produced, and the dev-login path. Then read the brief at ${A.briefPath} in full — it carries the ticket's user-facing flows and any local verify setup (port, seeded login, seeded data); a login or setup detail counts as missing only once you have read all of it. Then drive the RUNNING app exactly as it says (do not invoke the \`verify\` skill: it is user-invocable only and the Skill tool refuses it). Verification is evidence; "it should work" is a failure.
${onlyFlows ? `Re-verify ONLY these flows: ${onlyFlows.join('; ')}.` : criteria.length ? 'Exercise every flow needed to evidence the criteria below — full interaction, not just navigation. Do not exercise flows that belong to other criteria.' : 'Exercise every user-facing flow the ticket changes (the brief at ' + A.briefPath + ' lists them) — full interaction, not just navigation.'}
Acceptance criteria to evidence (map EVERY one: a recording + timestamp or screenshot step for user-facing ones; for backend-only ones the named passing test and the assertion in it that proves the specific outcome — a test that passes without asserting that outcome is no evidence; no evidence = status "missing"; return each criterion's \`id\` exactly as shown in brackets):
${criteria.length ? criteria.map(c => `- [${c.id}] ${c.text}`).join('\n') : '- (none assigned to this agent: report flows only)'}
${u.surface === 'api' || u.idx > 0 || (onlyFlows && !onlyFlows.some(f => /^appearance:/i.test(f))) ? '' : `Appearance: ${onlyFlows ? 'for each "appearance: <page>" flow above' : 'for each page the ticket adds or changes'}, one screenshot is also appearance evidence — compare it with a neighbouring existing page of the same app; browser-default controls or missing styles are a failing flow named "appearance: <page>" whose failure text names the reference page and the stylesheet it uses.\n`}Append to ${A.repo}/.scratch/${A.ticket}/lifecycle/verify-${u.surface}-${u.idx}.md after EACH flow (name, result, evidence path) so nothing is lost if your context is compacted; set evidenceFile to that path. Use accessibility snapshots for navigation and take screenshots only as evidence frames; close the browser at the end so the recording flushes.
Device-only iOS features (device-sensor APIs, live microphone capture, Apple Sign-In, push) cannot be simulator-verified: mark them "device_only", never fake them.
If anything environmental is missing or wrong (dev server down, server not serving this worktree/branch, DB, env var, driver not installed, no booted simulator, backend down) return status "setup_failure" with exactly what is missing and what you tried — do NOT work around it and do NOT fake a pass.${ATTEMPT}`,
  { label: `verify:${u.surface}${u.total > 1 ? ':' + (u.idx + 1) : ''}`, phase: 'Verify', model: 'sonnet', effort: 'medium', schema: VERIFY })
}

function gate() {
  const run = (cmd, n) => `\`cd ${A.repo} && log=$(mktemp) && ( ${cmd} ) > "$log" 2>&1; echo "EXIT=$?"; tail -${n} "$log"\``
  return agent(`Test gate for ${A.ticket} in ${A.repo} on branch ${A.branch}. Do not fix, commit, stage, or delete anything. Run these in order and report what they print, verbatim:
1. \`git -C ${A.repo} rev-parse HEAD\` → headSha (the full 40-character SHA).
2. \`git -C ${A.repo} status --porcelain\` → porcelain: every printed line, unchanged (empty list if it prints nothing). Run this BEFORE the tests so files they create do not count.
3. ${run(A.testCmd, 40)} → testExit = the integer after "EXIT=".
4. ${run(A.typecheckCmd, 30)} → typecheckExit = the integer after "EXIT=".
summary = the pass/fail counts and the first failing test or type error, if any. Do not judge pass/fail yourself beyond that: the exit codes decide.${ATTEMPT}`,
    { label: 'gate', phase: 'Gate', model: 'haiku', effort: 'low', schema: GATE })
}

// Gate verdict, decided here rather than by the gate agent. Untracked lifecycle scratch (.scratch/, saved .maestro/ flows)
// never blocks; any other uncommitted change does, because the PR would not contain what the suite just ran on.
const SCRATCH_UNTRACKED = /^\?\? (.*\/)?\.(scratch|maestro)(\/|$)/
function judgeGate(g, expectedSha) {
  if (!g) return { green: false, summary: 'gate agent died', problems: ['gate agent died'], dirty: [], resumable: true }
  const dirty = (g.porcelain || []).map(l => String(l)).filter(l => l.trim() && !SCRATCH_UNTRACKED.test(l))
  const problems = []
  if (g.testExit !== 0) problems.push(`suite exited ${g.testExit}`)
  if (g.typecheckExit !== 0) problems.push(`typecheck exited ${g.typecheckExit}`)
  if (dirty.length) problems.push(`uncommitted changes the PR would not contain: ${dirty.join(', ')}`)
  if (!sameSha(g.headSha, expectedSha)) problems.push(`gate ran on HEAD ${g.headSha || '?'}, expected ${expectedSha}`)
  // A red suite or a dirty tree needs a fix dispatch, not a resume; only a wrong HEAD (or a dead agent) is worth re-running as is.
  const resumable = g.testExit === 0 && g.typecheckExit === 0 && !dirty.length
  return { ...g, dirty, green: problems.length === 0, problems, resumable }
}

// Review one range with the owners that apply; returns routed findings plus which owners actually returned.
async function reviewRange(range, s, round, opts) {
  const level = s.diffLines < 100 ? 'medium' : 'high'
  const effort = (round === 1 && s.diffLines >= 100) ? 'high' : 'medium'
  const owners = ['correctness']
  const reviewers = [() => reviewCorrectness(range, level, effort, round, opts.labelPrefix)]
  if (opts.spec) { owners.push('spec'); reviewers.push(() => reviewSpec(range, opts.deviations || [])) }
  if (opts.structure) { owners.push('structure'); reviewers.push(() => reviewStructure(range, effort)) }
  if (s.securityFired) { owners.push('security'); reviewers.push(() => reviewSecurity(range, level, effort, s.securityReasons, round, opts.labelPrefix)) }
  const outs = await parallel(reviewers)
  const ranOwners = owners.filter((_, i) => outs[i] && outs[i].findings)
  const died = owners.filter(o => !ranOwners.includes(o))
  // A review that did not happen is not a clean review: correctness and security dying blocks; structure is logged.
  if (died.includes('correctness') || died.includes('security')) return { level, effort, owners, ranOwners, died, findings: [] }
  if (died.length) log(`${opts.labelPrefix}${died.join('+')} reviewer died — skipped this round`)
  let findings = []
  outs.forEach((o, i) => { if (o && o.findings) findings.push(...o.findings.map(f => ({ ...f, owner: owners[i] }))) })
  findings = dedupeRound(findings)
  return { level, effort, owners, ranOwners, died, findings }
}
const reviewDied = (rv, stage) => ({ stage, detail: `reviewer(s) died: ${rv.died.join(', ')} — nothing was reviewed in their place`, labels: rv.died, resumable: true })

// =========================================================================== build
async function runBuild() {
  need(['slices'])
  if (!Array.isArray(A.slices) || A.slices.length === 0) A.slices = [{ name: 'whole-ticket', scope: 'the whole ticket as described in the brief', seams: A.seams }]
  const MAX_FIX_ROUNDS = A.maxFixRounds ?? 1
  const STRUCTURE_MIN_LINES = A.structureMinLines ?? 150
  const result = { stage: 'build', ticket: A.ticket, branch: A.branch, base: A.base, slices: [], rounds: [], fixed: [], plausibleFixed: [], knownNotFixed: [], deferredOutOfScope: [], lowFindings: [], rejected: [], deviations: [], security: { rounds: [], skippedReasons: [] } }

  phase('Build')
  let prev = ''
  let last = null
  for (let i = 0; i < A.slices.length; i++) {
    const sl = A.slices[i]
    const b = await buildSlice(sl, i, A.slices.length, prev)
    result.slices.push({ name: sl.name, status: b && b.status, headSha: b && b.headSha, summary: b && b.summary, testsAdded: b && b.testsAdded })
    if (failedBuild(b)) { result.blocked = blockRecord(b, { stage: 'build', slice: sl.name }); return result }
    result.deviations.push(...(b.deviations || []))
    prev += `- ${sl.name}: ${b.summary}${b.filesTouched && b.filesTouched.length ? ` (files: ${b.filesTouched.join(', ')})` : ''}${b.notesForNextSlice ? `\n  ${b.notesForNextSlice}` : ''}\n`
    last = b
    log(`built slice ${i + 1}/${A.slices.length}: ${sl.name}`)
  }

  let headSha = last.headSha
  let reviewedSha = null
  let s = await ensureScout(last, `${A.base}...HEAD`, 'build')
  if (!s) { result.blocked = { stage: 'scout', detail: 'scout agent died', resumable: true }; return result }

  for (let round = 1; round <= 1 + MAX_FIX_ROUNDS; round++) {
    const range = round === 1 ? `${A.base}...HEAD` : `${reviewedSha}..HEAD`
    if (!s.securityFired) result.security.skippedReasons.push(`round ${round}: no path/content trigger on ${range} (${s.files.length} files, ${s.diffLines} lines)`)
    const structure = round === 1 && !!A.structureSkill && s.diffLines >= STRUCTURE_MIN_LINES
    if (round === 1 && !A.structureSkill) log('structure review skipped: args.structureSkill not set (no maintainability-review skill configured)')
    else if (round === 1 && !structure) log(`structure review skipped: ${s.diffLines} changed lines < ${STRUCTURE_MIN_LINES}`)

    phase('Review')
    const rv = await reviewRange(range, s, round, { structure, spec: round === 1, deviations: result.deviations, labelPrefix: `review:r${round}:` })
    if (rv.died.includes('correctness') || rv.died.includes('security')) { result.blocked = reviewDied(rv, `review:r${round}`); return result }
    if (rv.ranOwners.includes('security')) result.security.rounds.push(round)
    reviewedSha = headSha
    log(`round ${round}: ${rv.findings.length} findings on ${range} (${rv.ranOwners.join('+')}, level ${rv.level}, effort ${rv.effort})`)

    const r = route(rv.findings, round, s.files)
    result.lowFindings.push(...r.low.map(slim)); result.knownNotFixed.push(...r.known); result.deferredOutOfScope.push(...r.outOfScope.map(f => ({ ...slim(f), remedy: f.remedy, files_touched_by_remedy: f.files_touched_by_remedy })))
    const toFix = [...r.direct]
    if (r.toAssess.length) {
      phase('Fix')
      const a = await assess(r.toAssess, s.files)
      if (a) { toFix.push(...a.toFix.map(f => ({ ...f, owner: f.owner || 'review' }))); result.rejected.push(...a.rejected); result.deferredOutOfScope.push(...a.deferred) }
      else result.knownNotFixed.push(...r.toAssess)
    }
    result.rounds.push({ round, range, level: rv.level, effort: rv.effort, owners: rv.ranOwners, found: rv.findings.length, direct: r.direct.length, assessed: r.toAssess.length, toFix: toFix.length })
    if (!toFix.length) { log(`round ${round}: nothing to fix — review loop converged`); break }

    phase('Fix')
    const f = await fixer(`fix:r${round}`, `Findings to fix:\n${toFix.map(fmt).join('\n')}`, `${reviewedSha}..HEAD`)
    if (failedBuild(f)) { result.blocked = blockRecord(f, { stage: 'fix', round }); return result }
    result.deviations.push(...(f.deviations || []))
    if (sameSha(f.headSha, headSha)) {
      // Nothing was committed: nothing was fixed, and there is nothing new to review.
      log(`round ${round}: fixer committed nothing — ${toFix.length} finding(s) recorded as not fixed`)
      result.knownNotFixed.push(...toFix.map(x => ({ ...slim(x), reason: `fixer committed nothing: ${f.detail || f.summary}` })))
      break
    }
    headSha = f.headSha
    s = await ensureScout(f, `${reviewedSha}..HEAD`, `fix:r${round}`)
    if (!s) { result.blocked = { stage: 'scout', detail: 'scout agent died', resumable: true }; return result }
    const { fixed, notFixed } = splitFixed(toFix, f)
    result.fixed.push(...fixed.map(slim))
    result.plausibleFixed.push(...fixed.filter(x => x.verdict === 'PLAUSIBLE'))
    result.knownNotFixed.push(...notFixed)
    if (round === 1 + MAX_FIX_ROUNDS) {
      // Fixed but not re-reviewed here: the verify stage's final review covers reviewedSha..HEAD.
      result.unreviewedFix = { round, count: fixed.length }
      log(`round ${round}: ${fixed.length} fix(es) committed; re-review deferred to the verify stage's final review`)
    }
  }

  result.headSha = headSha
  result.reviewedSha = reviewedSha
  return result
}

// =========================================================================== verify
async function runVerify() {
  need(['headSha', 'reviewedSha', 'surfaces', 'criteria', 'driversRef'])
  const SURFACES = ['web', 'ios', 'portal', 'api']
  if (!Array.isArray(A.surfaces) || !A.surfaces.length || A.surfaces.some(x => !SURFACES.includes(x))) throw new Error(`args.surfaces must be a non-empty list drawn from ${SURFACES.join('|')}`)
  if (!Array.isArray(A.criteria) || A.criteria.some(c => typeof c !== 'string' || !c.trim())) throw new Error('args.criteria must be a list of non-empty strings (the acceptance criteria verbatim, in stable order)')
  const MAX_VERIFY_ROUNDS = A.maxVerifyRounds ?? 2
  const VERIFY_CHUNK = A.verifyChunk ?? 4
  const result = { stage: 'verify', ticket: A.ticket, branch: A.branch, base: A.base, headSha: A.headSha, reviewedSha: A.reviewedSha, verify: { ran: !A.skipVerify, rounds: [], flows: [], criteria: [], unmatched: [], evidenceFiles: [] }, finalReview: null, fixed: [], plausibleFixed: [], knownNotFixed: [], rejected: [], deviations: [], security: { ran: false, skippedReason: null } }
  let headSha = A.headSha
  let s = null                            // scout over A.reviewedSha..HEAD, from the last fixer

  // 0. Pick-up mode: address PR comments first.
  if (A.fixBrief) {
    phase('Fix')
    const f = await fixer('fix:pr-comments', `Address these PR comments:\n${A.fixBrief}`, `${A.reviewedSha}..HEAD`)
    if (failedBuild(f)) { result.blocked = blockRecord(f, { stage: 'fix:pr-comments' }); return result }
    result.deviations.push(...(f.deviations || []))
    if (sameSha(f.headSha, headSha)) { result.blocked = { stage: 'fix:pr-comments', detail: `fixer committed nothing: ${f.detail || f.summary}`, resumable: false }; return result }
    headSha = f.headSha
    s = await ensureScout(f, `${A.reviewedSha}..HEAD`, 'fix:pr-comments')
    if (!s) { result.blocked = { stage: 'scout', detail: 'scout agent died', resumable: true }; return result }
    result.fixed.push({ summary: 'PR comments addressed', detail: f.summary, unfixed: f.unfixed || [] })
  }

  // Merged evidence state across rounds: a criterion once evidenced stays evidenced.
  const flows = {}      // `${surface}|${name}` → latest flow record (+surface)
  // Criteria are keyed by a stable id (C1..Cn, by position in A.criteria); text is the ticket's verbatim wording.
  const CRIT = A.criteria.map((text, i) => ({ id: 'C' + (i + 1), text }))
  const byText = {}     // normalised text → id; ambiguous texts map to null and never match
  for (const c of CRIT) { const k = normText(c.text); byText[k] = k in byText ? null : c.id }
  const crit = {}       // id → latest best record; seeded so a criterion no agent returns still shows up as missing
  for (const c of CRIT) crit[c.id] = { id: c.id, criterion: c.text, status: 'missing', evidence: 'not reported by any verify agent', returned: false }
  const mergeOut = (o, unit) => {
    if (o.evidenceFile && !result.verify.evidenceFiles.includes(o.evidenceFile)) result.verify.evidenceFiles.push(o.evidenceFile)
    for (const fl of o.flows) flows[`${o.surface}|${fl.name}`] = { ...fl, surface: o.surface }
    const mine = new Set(unit.criteria.map(c => c.id))
    for (const c of o.criteria) {
      const pid = parseId(c.id)
      const id = mine.has(pid) ? pid : (byText[normText(c.criterion)] || null)
      if (!id || !mine.has(id)) { result.verify.unmatched.push({ ...c, surface: o.surface }); log(`verify: unmatched criterion from ${o.surface}: ${c.id || ''} "${c.criterion || ''}"`); continue }
      const cur = crit[id]
      if (cur.status === 'missing' || c.status === 'evidenced') crit[id] = { ...c, id, criterion: CRIT[+id.slice(1) - 1].text, surface: o.surface, returned: true }
    }
  }
  const snapshot = () => { result.verify.flows = Object.values(flows); result.verify.criteria = Object.values(crit) }
  const flowsFor = surface => Object.values(flows).filter(f => f.surface === surface).map(f => f.name)

  const units = A.surfaces.flatMap(surface => { const cs = chunk(CRIT, VERIFY_CHUNK); return cs.map((c, idx) => ({ surface, criteria: c, idx, total: cs.length })) })
  if (units.length > A.surfaces.length) log(`verify split into ${units.length} agents (${A.surfaces.length} surface(s) × ${Math.ceil(A.criteria.length / VERIFY_CHUNK)} criteria groups of ≤${VERIFY_CHUNK})`)

  const runUnits = async (pending, round) => {
    const outs = await parallel(pending.map(p => () => verifyUnit(p.unit, p.onlyFlows, p.onlyCriteria)))
    if (outs.some(o => !o)) return { died: true }
    const setup = outs.find(o => o.status === 'setup_failure')
    if (setup) return { setup }
    outs.forEach((o, i) => mergeOut(o, pending[i].unit)); snapshot()
    // Per-unit failures, judged on the merged state. fixLines go to the fixer (the app is wrong); gapLines re-verify only.
    // A failing flow is always the app's fault. A criterion returned "missing" is first treated as a verification
    // gap (the agent could not evidence it) and re-verified once; only if it is still missing in a later round, or the
    // same unit also has a failing flow, does it reach the fixer. Criteria no agent reported are always a gap.
    const next = []
    const fixLines = [], gapLines = []
    pending.forEach((p, i) => {
      const o = outs[i]
      const badFlows = o.flows.filter(f => f.status === 'fail')
      const missing = p.unit.criteria.filter(c => crit[c.id].status === 'missing')
      badFlows.forEach(f => fixLines.push(`[${o.surface}] flow "${f.name}": ${f.failure || f.evidence}`))
      missing.forEach(c => {
        const rec = crit[c.id]
        if (!rec.returned) gapLines.push(`[${o.surface}] [${c.id}] criterion not reported by the verify agent: "${c.text}"`)
        else if (round === 1 && !badFlows.length) gapLines.push(`[${o.surface}] [${c.id}] criterion without evidence, re-verifying first: "${c.text}" — ${rec.evidence || 'no evidence returned'}`)
        else fixLines.push(`[${o.surface}] [${c.id}] criterion without evidence: "${c.text}" — ${rec.evidence || 'no evidence returned'}`)
      })
      if (badFlows.length || missing.length) next.push({ unit: p.unit, onlyFlows: badFlows.length ? badFlows.map(f => f.name) : null, onlyCriteria: missing.length ? missing : p.unit.criteria })
    })
    const fl = [...new Set(fixLines)], gl = [...new Set(gapLines)]
    return { fixLines: fl, gapLines: gl, failureLines: [...fl, ...gl], next }
  }

  // 1. Verify loop. Setup failure short-circuits to the orchestrator; only failed units/flows re-run.
  if (!A.skipVerify) {
    let pending = units.map(unit => ({ unit, onlyFlows: null, onlyCriteria: null }))
    for (let round = 1; round <= 1 + MAX_VERIFY_ROUNDS; round++) {
      phase('Verify')
      const r = await runUnits(pending, round)
      if (r.died) { result.blocked = { stage: 'verify', detail: 'a verify agent died', resumable: true }; return result }
      if (r.setup) { result.blocked = { stage: 'verify:setup', surface: r.setup.surface, detail: r.setup.setupDetail, resumable: true }; return result }
      result.verify.rounds.push({ round, agents: pending.length, failures: r.failureLines.length })
      log(`verify round ${round}: ${r.failureLines.length} failure(s)`)
      if (!r.failureLines.length) break
      if (round === 1 + MAX_VERIFY_ROUNDS) { result.blocked = { stage: 'verify:cap', detail: r.failureLines.join('\n'), resumable: false }; return result }
      if (!r.fixLines.length) { log(`verify round ${round}: report gaps only — re-verifying without a fix`); pending = r.next; continue }
      phase('Fix')
      const f = await fixer(`fix:verify:r${round}`, `Verification failures to fix (each is a behaviour the running app must show):\n${r.fixLines.map(x => `- ${x}`).join('\n')}`, `${A.reviewedSha}..HEAD`)
      if (failedBuild(f)) { result.blocked = blockRecord(f, { stage: `fix:verify:r${round}` }); return result }
      result.deviations.push(...(f.deviations || []))
      if (sameSha(f.headSha, headSha)) { result.blocked = { stage: `fix:verify:r${round}`, detail: `fixer committed nothing, so re-verifying would fail the same way: ${f.detail || f.summary}\n${r.fixLines.join('\n')}`, resumable: false }; return result }
      headSha = f.headSha
      s = await ensureScout(f, `${A.reviewedSha}..HEAD`, `fix:verify:r${round}`)
      if (!s) { result.blocked = { stage: 'scout', detail: 'scout agent died', resumable: true }; return result }
      result.fixed.push({ summary: `verify round ${round} fixes`, detail: f.summary, unfixed: f.unfixed || [] })
      pending = r.next
    }
  } else {
    log('verify skipped at the user\'s request — the Slack message must say so')
  }

  // 2. Final review — once, only if code changed since REVIEWED_SHA. Round-2 routing: CONFIRMED → fix, PLAUSIBLE → PR body.
  if (!sameSha(headSha, A.reviewedSha)) {
    phase('Final review')
    const range = `${A.reviewedSha}..HEAD`
    if (!s) { const sa = await scoutAgent(range, 'scout:final'); if (!sa) { result.blocked = { stage: 'final:scout', detail: 'scout agent died', resumable: true }; return result }; s = sa; headSha = sa.headSha || headSha }
    if (!s.securityFired) result.security.skippedReason = `no path/content trigger on ${range} (${s.files.length} files, ${s.diffLines} lines)`
    const rv = await reviewRange(range, s, 2, { structure: false, labelPrefix: 'final:' })
    if (rv.died.includes('correctness') || rv.died.includes('security')) { result.blocked = reviewDied(rv, 'final'); return result }
    result.security.ran = rv.ranOwners.includes('security')
    const r = route(rv.findings, 2, s.files)
    result.finalReview = { range, level: rv.level, effort: rv.effort, owners: rv.ranOwners, found: rv.findings.length, toFix: r.direct.length, known: r.known.length, low: r.low.length }
    result.knownNotFixed.push(...r.known, ...r.low.map(slim))
    result.reviewedSha = headSha
    if (r.direct.length) {
      phase('Fix')
      const f = await fixer('fix:final', `Findings to fix:\n${r.direct.map(fmt).join('\n')}`, `${headSha}..HEAD`)
      if (failedBuild(f)) { result.blocked = blockRecord(f, { stage: 'fix:final' }); return result }
      result.deviations.push(...(f.deviations || []))
      if (sameSha(f.headSha, headSha)) {
        log(`final fix: fixer committed nothing — ${r.direct.length} finding(s) recorded as not fixed`)
        result.knownNotFixed.push(...r.direct.map(x => ({ ...slim(x), reason: `fixer committed nothing: ${f.detail || f.summary}` })))
      } else {
        headSha = f.headSha
        const { fixed, notFixed } = splitFixed(r.direct, f)
        result.fixed.push(...fixed.map(slim))
        result.knownNotFixed.push(...notFixed)
        result.unreviewedFix = { stage: 'final', count: fixed.length }   // covered by tests + the re-verify below, by design
        // Re-verify only surfaces that recorded flows: evidence is sticky, so a surface with no flows cannot fail here.
        const pending = A.skipVerify ? [] : units.map(unit => ({ unit, onlyFlows: flowsFor(unit.surface), onlyCriteria: null })).filter(p => p.onlyFlows.length)
        if (pending.length) {
          phase('Verify')
          const r2 = await runUnits(pending, 2)
          if (r2.died) { result.blocked = { stage: 'final:reverify', detail: 'a verify agent died', resumable: true }; return result }
          if (r2.setup) { result.blocked = { stage: 'verify:setup', surface: r2.setup.surface, detail: r2.setup.setupDetail, resumable: true }; return result }
          result.verify.rounds.push({ round: 'post-final', agents: pending.length, failures: r2.failureLines.length })
          if (r2.failureLines.length) { result.blocked = { stage: 'final:reverify', detail: r2.failureLines.join('\n'), resumable: false }; return result }
        }
      }
    }
  }

  // 3. Gate — the single independent run of suite + typecheck in the whole lifecycle.
  phase('Gate')
  const g = await gate()
  result.gate = judgeGate(g, headSha)
  result.headSha = (g && g.headSha) || headSha
  if (!result.gate.green) result.blocked = { stage: 'gate', detail: `${result.gate.problems.join('; ')}${g ? ` — ${g.summary}` : ''}`, resumable: result.gate.resumable }
  return result
}

return A.stage === 'build' ? await runBuild() : await runVerify()
