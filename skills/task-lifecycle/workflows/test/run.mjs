#!/usr/bin/env node
// Stub harness for workflows/lifecycle.js. No dependencies: `node skills/task-lifecycle/workflows/test/run.mjs`.
// Replaces agent()/parallel()/phase()/log() with scripted responders keyed by agent label and asserts the
// routing the script owns (blocks, resume flags, fix accounting, verify gap-vs-fix, final review, gate verdict).
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lifecycle.js'), 'utf8')
// Drop the `export const meta = {...}` literal; the body is plain async JS with a top-level return.
const body = src.replace(/^export const meta = \{[\s\S]*?\n\}\n/, '')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const script = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body)

// ---------------------------------------------------------------- runner
async function run(args, respond) {
  const calls = []
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt, opts })
    const out = await respond(label, prompt, opts, calls)
    return out === undefined ? null : out
  }
  const parallel = thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const logs = []
  const result = await script(args, agent, parallel, () => {}, m => logs.push(m))
  return { result, calls, logs }
}

const SHA = n => String(n).repeat(40).slice(0, 40)        // '1' → '1111…', 40 chars
const scout = (o = {}) => ({ files: ['src/a.ts'], diffLines: 200, securityFired: false, securityReasons: [], ...o })
const done = (sha, o = {}) => ({ status: 'done', headSha: sha, suitePassed: true, typecheckPassed: true, summary: 'ok', ...o })
const finding = (o = {}) => ({ file: 'src/a.ts', line: 10, severity: 'medium', verdict: 'CONFIRMED', summary: 'off by one', failure_scenario: 'empty list', remedy: 'fix bound', ...o })
const none = { findings: [] }
const verifyOk = (surface, ids, flows = [{ name: 'login', status: 'pass', evidence: 'rec.webm' }]) => ({ status: 'pass', surface, flows, criteria: ids.map(id => ({ id, status: 'evidenced', evidence: 'rec.webm@0:10' })) })
const gateOk = sha => ({ headSha: sha, porcelain: ['?? .scratch/'], testExit: 0, typecheckExit: 0, summary: '12 passed' })

const common = { ticket: 'PROJ-1', repo: '/wt', base: 'main', branch: 'feature/PROJ-1_x', briefPath: '/wt/.scratch/PROJ-1/lifecycle/brief.md', seams: ['POST /x'], testCmd: 'pnpm test', typecheckCmd: 'pnpm typecheck', scoutScript: '/skill/reference/scout.sh' }
const buildArgs = o => ({ ...common, stage: 'build', slices: [{ name: 'whole', scope: 'all', seams: ['POST /x'] }], structureSkill: '/skills/structure/SKILL.md', ...o })
const verifyArgs = o => ({ ...common, stage: 'verify', headSha: SHA(1), reviewedSha: SHA(1), surfaces: ['web'], criteria: ['User sees the thing.', 'Thing is saved.'], driversRef: '/skill/reference/verify-drivers.md', ...o })

// ---------------------------------------------------------------- tiny test kit
let passed = 0, failed = 0
const eq = (a, b, msg) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`) }
const ok = (c, msg) => { if (!c) throw new Error(msg) }
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`) }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}
const count = (calls, prefix) => calls.filter(c => c.label.startsWith(prefix)).length

// ================================================================ build stage
console.log('build stage')

await test('happy path: CONFIRMED direct + PLAUSIBLE assessed, fixed, converges in round 2', async () => {
  const { result, calls } = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout() })
    if (label === 'review:r1:correctness') return { findings: [finding(), finding({ line: 20, verdict: 'PLAUSIBLE', summary: 'maybe null' })] }
    if (label === 'review:structure' || label === 'review:spec') return none
    if (label === 'assess') return { toFix: [finding({ line: 20, verdict: 'PLAUSIBLE', summary: 'maybe null' })], rejected: [], deferred: [] }
    if (label === 'fix:r1') return done(SHA(2), { scout: scout({ diffLines: 12 }), unfixed: [] })
    if (label === 'review:r2:correctness') return none
  })
  ok(!result.blocked, 'not blocked')
  eq(result.rounds.length, 2, 'two rounds')
  eq(result.rounds[0].owners, ['correctness', 'spec', 'structure'], 'round 1 owners are the ones that ran')
  eq(result.fixed.length, 2, 'both fixed'); eq(result.plausibleFixed.length, 1, 'one plausible fixed')
  eq(result.headSha, SHA(2), 'head is the fix'); eq(result.reviewedSha, SHA(2), 'reviewed through the fix')
  eq(count(calls, 'review:structure'), 1, 'structure ran once (round 1 only)')
  eq(count(calls, 'scout:'), 0, 'no scout agent when the builder returned one')
  eq(result.security.rounds, [], 'security did not run'); eq(result.security.skippedReasons.length, 2, 'skip reason per round')
  ok(!result.unreviewedFix, 'the round-1 fix was re-reviewed')
})

await test('dead correctness reviewer blocks instead of converging', async () => {
  const { result } = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return null
  })
  eq(result.blocked && result.blocked.stage, 'review:r1', 'blocked at review')
  eq(result.blocked.resumable, true, 'resumable')
  eq(result.rounds.length, 0, 'no round recorded as reviewed')
})

await test('dead security reviewer blocks; dead structure reviewer is skipped', async () => {
  const sec = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20, securityFired: true, securityReasons: ['path: db/x.sql'] }) })
    if (label === 'review:r1:correctness') return none
    if (label === 'review:r1:security') return null
  })
  eq(sec.result.blocked && sec.result.blocked.stage, 'review:r1', 'security death blocks')
  const str = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout() })
    if (label === 'review:r1:correctness') return none
    if (label === 'review:structure') return null
  })
  ok(!str.result.blocked, 'structure death does not block')
  eq(str.result.rounds[0].owners, ['correctness'], 'structure not reported as having run')
})

await test('done with an empty scout → scout agent measures instead', async () => {
  const { result, calls } = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ files: [], diffLines: 0 }) })
    if (label === 'scout:build') return scout({ diffLines: 300, securityFired: true, securityReasons: ['line: execute(q)'] })
    if (label.startsWith('review:r1:')) return none
    if (label === 'review:structure') return none
  })
  ok(!result.blocked, 'not blocked')
  eq(count(calls, 'scout:build'), 1, 'scout agent ran')
  eq(result.rounds[0].owners, ['correctness', 'structure', 'security'], 'reviews decided on the measured scout')
})

await test('multi-slice: only the last builder runs the scout; earlier builders are told not to', async () => {
  const { calls } = await run(buildArgs({ slices: [{ name: 's1', scope: 'tracer', seams: ['POST /x'] }, { name: 's2', scope: 'widen', seams: ['POST /x'] }] }), label => {
    if (label === 'build:s1') return done(SHA(1))
    if (label === 'build:s2') return done(SHA(2), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return none
  })
  const s1 = calls.find(c => c.label === 'build:s1'), s2 = calls.find(c => c.label === 'build:s2')
  ok(!s1.prompt.includes('scout.sh'), 'slice 1 prompt has no scout'); ok(s2.prompt.includes('scout.sh'), 'slice 2 prompt runs the scout')
  ok(s1.prompt.includes('leave "scout" unset'), 'slice 1 told to leave scout unset')
})

await test('fixer unfixed items are not reported fixed; same-SHA fixer ends the loop without a round-2 review', async () => {
  const two = [finding(), finding({ line: 30, summary: 'wrong key' })]
  const a = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return { findings: two }
    if (label === 'fix:r1') return done(SHA(2), { scout: scout({ diffLines: 5 }), unfixed: [{ summary: 'wrong key', reason: 'not reproducible' }] })
    if (label === 'review:r2:correctness') return none
  })
  eq(a.result.fixed.map(f => f.summary), ['off by one'], 'only the fixed one is fixed')
  eq(a.result.knownNotFixed.map(f => f.summary), ['wrong key'], 'unfixed lands in knownNotFixed')
  const b = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return { findings: two }
    if (label === 'fix:r1') return done(SHA(1), { scout: scout({ files: [], diffLines: 0 }), summary: 'nothing to change' })
  })
  ok(!b.result.blocked, 'a no-op fix is not a block')
  eq(count(b.calls, 'review:r2'), 0, 'no round-2 review on an empty range')
  eq(count(b.calls, 'scout:'), 0, 'no scout agent for a no-op fix')
  eq(b.result.fixed.length, 0, 'nothing fixed'); eq(b.result.knownNotFixed.length, 2, 'both recorded as not fixed')
  eq(b.result.headSha, SHA(1), 'head unchanged')
})

await test('blocked records: needs_seam and a red suite are not resumable; an environmental block is', async () => {
  const seam = await run(buildArgs(), label => { if (label === 'build:whole') return { status: 'needs_seam', headSha: '', suitePassed: false, typecheckPassed: false, summary: 'x', detail: 'need GET /y' } })
  eq(seam.result.blocked.status, 'needs_seam', 'seam'); eq(seam.result.blocked.resumable, false, 'needs_seam not resumable')
  const red = await run(buildArgs(), label => { if (label === 'build:whole') return done(SHA(1), { suitePassed: false, scout: scout() }) })
  eq(red.result.blocked.resumable, false, 'red suite not resumable'); eq(red.result.blocked.suitePassed, false, 'flag carried')
  const env = await run(buildArgs(), label => { if (label === 'build:whole') return { status: 'blocked', headSha: '', suitePassed: false, typecheckPassed: false, summary: 'x', detail: 'no DB' } })
  eq(env.result.blocked.resumable, true, 'env block resumable')
  const died = await run(buildArgs(), () => null)
  eq(died.result.blocked.status, 'died', 'died'); eq(died.result.blocked.resumable, true, 'died resumable')
})

await test('attempt: 2 tags only builder, verify and gate prompts', async () => {
  const b = await run(buildArgs({ attempt: 2 }), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return { findings: [finding()] }
    if (label === 'fix:r1') return done(SHA(2), { scout: scout({ diffLines: 3 }) })
    if (label === 'review:r2:correctness') return none
  })
  const tagged = b.calls.filter(c => c.prompt.includes('[attempt 2]')).map(c => c.label)
  eq(tagged, ['build:whole'], 'build stage: only the builder is tagged')
  const v = await run(verifyArgs({ attempt: 2 }), label => {
    if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2'])
    if (label === 'gate') return gateOk(SHA(1))
  })
  eq(v.calls.filter(c => c.prompt.includes('[attempt 2]')).map(c => c.label), ['verify:web', 'gate'], 'verify stage: units and gate tagged')
  const plain = await run(verifyArgs(), label => { if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2']); if (label === 'gate') return gateOk(SHA(1)) })
  eq(plain.calls.some(c => c.prompt.includes('[attempt')), false, 'no tag at attempt 1')
})

await test('dedupe keys on file, line and summary: two findings on one line both survive; unfixed one leaves the other fixed', async () => {
  const pair = [finding(), finding({ summary: 'missing length cap' })]
  const { result, calls } = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return { findings: [...pair, finding()] }
    if (label === 'fix:r1') return done(SHA(2), { scout: scout({ diffLines: 5 }), unfixed: [{ file: 'src/a.ts', line: 10, summary: 'missing length cap', reason: 'needs a migration' }] })
    if (label === 'review:r2:correctness') return none
  })
  const fix = calls.find(c => c.label === 'fix:r1').prompt
  ok(fix.includes('off by one') && fix.includes('missing length cap'), 'both same-line findings reach the fixer')
  eq(result.rounds[0].found, 2, 'the exact duplicate collapses, the distinct one survives')
  eq(result.fixed.map(f => f.summary), ['off by one'], 'the other same-line finding is fixed')
  eq(result.knownNotFixed.map(f => f.summary), ['missing length cap'], 'only the matching one is unfixed')
})

await test('unfixed entry with a shared summary narrows by file + line: the other "untested guard" stays fixed', async () => {
  const g = o => finding({ summary: 'untested guard', ...o })
  const { result } = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return { findings: [g({ file: 'src/a.ts', line: 10 }), g({ file: 'src/b.ts', line: 40 })] }
    if (label === 'fix:r1') return done(SHA(2), { scout: scout({ diffLines: 5 }), unfixed: [{ file: 'src/b.ts', line: 40, summary: 'untested guard', reason: 'no seam' }] })
    if (label === 'review:r2:correctness') return none
  })
  eq(result.fixed.map(f => f.file), ['src/a.ts'], 'a.ts fix kept')
  eq(result.knownNotFixed.map(f => f.file), ['src/b.ts'], 'only b.ts unfixed')
})

await test('spec reviewer: round 1 only, gets brief path and declared deviations, routes like correctness', async () => {
  const dev = { requirement: 'reject invalid input', instead: 'repairs it', why: 'ADR-0030' }
  const { result, calls } = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ files: ['src/a.ts'] }), deviations: [dev] })
    if (label === 'review:r1:correctness') return none
    if (label === 'review:structure') return none
    if (label === 'review:spec') return { findings: [
      finding({ file: 'src/other.ts', summary: 'acceptance criterion 2 missing', severity: 'high', files_touched_by_remedy: ['src/other.ts'] }),
      finding({ file: 'src/a.ts', line: 3, verdict: 'PLAUSIBLE', summary: 'undeclared deviation' }),
      finding({ line: 4, severity: 'low', summary: 'judgement call' }),
    ] }
    if (label === 'assess') return { toFix: [], rejected: [{ summary: 'undeclared deviation', reason: 'declared' }], deferred: [] }
    if (label === 'fix:r1') return done(SHA(2), { scout: scout({ diffLines: 5 }) })
    if (label === 'review:r2:correctness') return none
  })
  const spec = calls.filter(c => c.label === 'review:spec')
  eq(spec.length, 1, 'spec reviewer ran once')
  ok(spec[0].prompt.includes(common.briefPath), 'spec prompt has the brief path')
  ok(spec[0].prompt.includes('reject invalid input') && spec[0].prompt.includes('repairs it'), 'spec prompt has the declared deviations')
  eq(spec[0].opts.model, 'opus', 'opus'); eq(spec[0].opts.effort, 'medium', 'medium effort')
  eq(result.rounds[0].owners, ['correctness', 'spec', 'structure'], 'spec recorded as an owner')
  ok(calls.find(c => c.label === 'fix:r1').prompt.includes('acceptance criterion 2 missing'), 'CONFIRMED spec finding outside the touched files goes to the fixer (no scope guard)')
  ok(calls.find(c => c.label === 'assess').prompt.includes('undeclared deviation'), 'PLAUSIBLE spec finding goes to the assessor')
  eq(result.lowFindings.map(f => f.summary), ['judgement call'], 'low spec finding goes to the PR body')
  eq(calls.filter(c => /spec/.test(c.label)).length, 1, 'not called in round 2')
  const v = await run(verifyArgs({ headSha: SHA(2), reviewedSha: SHA(1) }), label => {
    if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2'])
    if (label === 'scout:final') return scout({ diffLines: 10, headSha: SHA(2) })
    if (label.startsWith('final:')) return none
    if (label === 'gate') return gateOk(SHA(2))
  })
  eq(v.calls.filter(c => /spec/.test(c.label)).length, 0, 'not called in the final review')
})

await test('assessor prompt carries the brief path', async () => {
  const { calls } = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return { findings: [finding({ verdict: 'PLAUSIBLE' })] }
    if (label === 'assess') return { toFix: [], rejected: [], deferred: [] }
  })
  ok(calls.find(c => c.label === 'assess').prompt.includes(common.briefPath), 'brief path in the assessor prompt')
})

await test('builder and fixer deviations aggregate into the build result; absent field → empty list', async () => {
  const d1 = { requirement: 'r1', instead: 'i1', why: 'w1' }, d2 = { requirement: 'r2', instead: 'i2', why: 'w2' }
  const { result } = await run(buildArgs({ slices: [{ name: 's1', scope: 'a', seams: ['POST /x'] }, { name: 's2', scope: 'b', seams: ['POST /x'] }] }), label => {
    if (label === 'build:s1') return done(SHA(1), { deviations: [d1] })
    if (label === 'build:s2') return done(SHA(2), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return { findings: [finding()] }
    if (label === 'fix:r1') return done(SHA(3), { scout: scout({ diffLines: 5 }), deviations: [d2] })
    if (label === 'review:r2:correctness') return none
  })
  eq(result.deviations, [d1, d2], 'builder + fixer deviations')
  const plain = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20 }) })
    if (label === 'review:r1:correctness') return none
  })
  eq(plain.result.deviations, [], 'absent → empty')
})

await test('prompt content: severity calibration, untested-guard rule, deviation sentence', async () => {
  const { calls } = await run(buildArgs(), label => {
    if (label === 'build:whole') return done(SHA(1), { scout: scout({ diffLines: 20, securityFired: true, securityReasons: ['path: x'] }) })
    if (label === 'review:r1:correctness') return { findings: [finding()] }
    if (label === 'review:r1:security') return none
    if (label === 'review:spec') return none
    if (label === 'fix:r1') return done(SHA(2), { scout: scout({ diffLines: 5, securityFired: true, securityReasons: ['path: x'] }) })
    if (label.startsWith('review:r2:')) return none
  })
  const p = l => calls.find(c => c.label === l).prompt
  for (const l of ['review:r1:correctness', 'review:r1:security']) {
    ok(p(l).includes('low is cosmetic only'), `${l}: new low definition`)
    ok(p(l).includes('delete'), `${l}: delete-the-line rule`)
  }
  ok(p('review:r1:correctness').includes('untested guard'), 'correctness: untested guard finding')
  for (const l of ['review:r2:correctness', 'review:r2:security']) ok(!p(l).includes('untested guard'), `${l}: no untested-guard rule on fix rounds`)
  ok(p('review:spec').includes('always PLAUSIBLE'), 'spec: "not asked for" findings go to the assessor')
  ok(!p('review:r1:security').includes('low = hardening'), 'security: "low = hardening" removed')
  for (const l of ['build:whole', 'fix:r1']) ok(p(l).includes('deviations'), `${l}: deviation sentence`)
})

// ================================================================ verify stage
console.log('verify stage')

await test('verify prompt carries the brief path, with or without criteria and on re-verify', async () => {
  for (const criteria of [['Only one.'], []]) {
    const { calls } = await run(verifyArgs({ criteria }), (label, prompt, opts, all) => {
      if (label.startsWith('verify:')) return count(all, 'verify:') === 1
        ? { status: 'fail', surface: 'web', flows: [{ name: 'save', status: 'fail', evidence: 'rec', failure: 'nothing saved' }], criteria: criteria.length ? [{ id: 'C1', status: 'evidenced', evidence: 'rec' }] : [] }
        : verifyOk('web', criteria.length ? ['C1'] : [])
      if (label === 'fix:verify:r1') return done(SHA(2), { scout: scout({ diffLines: 4 }) })
      if (label.startsWith('final:')) return none
      if (label === 'gate') return gateOk(SHA(2))
    })
    const ps = calls.filter(c => c.label === 'verify:web').map(c => c.prompt)
    eq(ps.length, 2, `${criteria.length} criteria: verify + re-verify`)
    for (const p of ps) ok(p.includes(common.briefPath), `${criteria.length} criteria: brief path in every verify prompt`)
  }
})

await test('verify: appearance rule in the verify prompt; fixer deviations aggregate; absent → empty', async () => {
  const d = { requirement: 'r', instead: 'i', why: 'w' }
  const { result, calls } = await run(verifyArgs({ criteria: ['Only one.'] }), (label, prompt, opts, all) => {
    if (label.startsWith('verify:')) return count(all, 'verify:') === 1
      ? { status: 'fail', surface: 'web', flows: [{ name: 'appearance: /notes', status: 'fail', evidence: 'shot.png', failure: 'browser-default buttons' }], criteria: [{ id: 'C1', status: 'evidenced', evidence: 'rec' }] }
      : verifyOk('web', ['C1'])
    if (label === 'fix:verify:r1') return done(SHA(2), { scout: scout({ diffLines: 4 }), deviations: [d] })
    if (label.startsWith('final:')) return none
    if (label === 'gate') return gateOk(SHA(2))
  })
  ok(calls.find(c => c.label === 'verify:web').prompt.includes('appearance'), 'appearance rule')
  ok(calls.filter(c => c.label === 'verify:web')[1].prompt.includes('for each "appearance: <page>" flow above'), 're-verify scopes the rule to the named flows')
  eq(result.deviations, [d], 'verify fixer deviations')
  const plain = await run(verifyArgs(), label => { if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2']); if (label === 'gate') return gateOk(SHA(1)) })
  eq(plain.result.deviations, [], 'absent → empty')
})

await test('verify: appearance rule only in the first criteria group, and dropped on re-verify without an appearance flow', async () => {
  const { calls } = await run(verifyArgs({ criteria: ['a.', 'b.', 'c.', 'd.', 'e.'] }), (label, prompt, opts, all) => {
    if (label === 'verify:web:1') return verifyOk('web', ['C1', 'C2', 'C3', 'C4'])
    if (label === 'verify:web:2') return count(all, 'verify:web:2') === 1
      ? { status: 'fail', surface: 'web', flows: [{ name: 'save', status: 'fail', evidence: 'x', failure: 'no save' }], criteria: [{ id: 'C5', status: 'evidenced', evidence: 'rec' }] }
      : verifyOk('web', ['C5'], [{ name: 'save', status: 'pass', evidence: 'y' }])
    if (label === 'fix:verify:r1') return done(SHA(2), { scout: scout({ diffLines: 4 }) })
    if (label.startsWith('final:')) return none
    if (label === 'gate') return gateOk(SHA(2))
  })
  const ps = l => calls.filter(c => c.label === l).map(c => c.prompt)
  ok(ps('verify:web:1')[0].includes('Appearance:'), 'group 1 has the rule')
  ok(!ps('verify:web:2')[0].includes('Appearance:'), 'group 2 does not')
  ok(!ps('verify:web:2')[1].includes('Appearance:'), 're-verify of a non-appearance flow does not')
})

await test('happy path: all evidenced, no final review when nothing changed, gate green', async () => {
  const { result, calls } = await run(verifyArgs(), label => {
    if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2'])
    if (label === 'gate') return gateOk(SHA(1))
  })
  ok(!result.blocked, 'not blocked'); eq(result.gate.green, true, 'green')
  eq(count(calls, 'final:'), 0, 'no final review'); eq(count(calls, 'scout:'), 0, 'no scout')
  eq(result.verify.criteria.map(c => c.status), ['evidenced', 'evidenced'], 'criteria merged')
})

await test('a "missing" criterion with no failing flow re-verifies in round 1 and only reaches the fixer in round 2', async () => {
  let n = 0
  const { result, calls } = await run(verifyArgs({ criteria: ['Only one.'] }), label => {
    if (label.startsWith('verify:')) { n++; return { status: 'fail', surface: 'web', flows: [{ name: 'login', status: 'pass', evidence: 'rec' }], criteria: [{ id: 'C1', status: 'missing', evidence: 'could not find the control' }] } }
    if (label === 'fix:verify:r2') return done(SHA(2), { scout: scout({ diffLines: 4 }) })
    if (label.startsWith('final:')) return none
    if (label === 'gate') return gateOk(SHA(2))
  })
  const fixCalls = calls.filter(c => c.label.startsWith('fix:verify:')).map(c => c.label)
  eq(fixCalls, ['fix:verify:r2'], 'fixer first dispatched after round 2')
  ok(calls.find(c => c.label === 'fix:verify:r2').prompt.includes('[C1] criterion without evidence'), 'fixer told about the criterion')
  eq(result.blocked && result.blocked.stage, 'verify:cap', 'still missing after the fix → cap')
  eq(result.blocked.resumable, false, 'cap not resumable')
  eq(n, 3, 'three verify rounds')
})

await test('a failing flow goes to the fixer in round 1', async () => {
  const { calls, result } = await run(verifyArgs({ criteria: ['Only one.'] }), (label, prompt, opts, all) => {
    if (label.startsWith('verify:')) return count(all, 'verify:') === 1
      ? { status: 'fail', surface: 'web', flows: [{ name: 'save', status: 'fail', evidence: 'rec', failure: 'button disabled' }], criteria: [{ id: 'C1', status: 'missing', evidence: 'blocked by the flow' }] }
      : verifyOk('web', ['C1'], [{ name: 'save', status: 'pass', evidence: 'rec2' }])
    if (label === 'fix:verify:r1') return done(SHA(2), { scout: scout({ diffLines: 4 }) })
    if (label.startsWith('final:')) return none
    if (label === 'gate') return gateOk(SHA(2))
  })
  eq(calls.filter(c => c.label.startsWith('fix:verify:')).map(c => c.label), ['fix:verify:r1'], 'fixer in round 1')
  ok(!result.blocked, 'passes after the fix')
  eq(count(calls, 'final:correctness'), 1, 'final review ran because code changed')
  eq(result.verify.rounds.map(r => r.round), [1, 2], 'two verify rounds')
})

await test('verify fixer that commits nothing blocks (not resumable) instead of re-verifying the same failure', async () => {
  const { result } = await run(verifyArgs({ criteria: ['Only one.'] }), label => {
    if (label.startsWith('verify:')) return { status: 'fail', surface: 'web', flows: [{ name: 'save', status: 'fail', evidence: 'rec', failure: 'broken' }], criteria: [{ id: 'C1', status: 'missing', evidence: '' }] }
    if (label === 'fix:verify:r1') return done(SHA(1), { summary: 'cannot see how' })
  })
  eq(result.blocked && result.blocked.stage, 'fix:verify:r1', 'blocked at the fixer'); eq(result.blocked.resumable, false, 'not resumable')
})

await test('setup failure blocks resumable; a dead verify agent blocks resumable', async () => {
  const s = await run(verifyArgs(), label => { if (label.startsWith('verify:')) return { status: 'setup_failure', surface: 'web', setupDetail: 'nothing on :3000', flows: [], criteria: [] } })
  eq(s.result.blocked.stage, 'verify:setup', 'setup'); eq(s.result.blocked.resumable, true, 'resumable'); eq(s.result.blocked.detail, 'nothing on :3000', 'detail')
  const d = await run(verifyArgs(), () => null)
  eq(d.result.blocked.stage, 'verify', 'died'); eq(d.result.blocked.resumable, true, 'resumable')
})

await test('short vs long SHA of the same commit → no final review', async () => {
  const { calls, result } = await run(verifyArgs({ headSha: SHA(1).slice(0, 7), reviewedSha: SHA(1) }), label => {
    if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2'])
    if (label === 'gate') return gateOk(SHA(1))
  })
  eq(count(calls, 'final:'), 0, 'no final review'); ok(!result.blocked, 'green')
})

await test('final review after a build-stage unreviewed fix: scout agent, CONFIRMED fixed, re-verify only surfaces with flows', async () => {
  const { calls, result } = await run(verifyArgs({ headSha: SHA(2), reviewedSha: SHA(1), surfaces: ['web', 'api'] }), label => {
    if (label === 'verify:web') return verifyOk('web', ['C1', 'C2'])
    if (label === 'verify:api') return { status: 'pass', surface: 'api', flows: [], criteria: [{ id: 'C1', status: 'missing', evidence: 'ui criterion' }, { id: 'C2', status: 'evidenced', evidence: 'test_save passes' }] }
    if (label === 'scout:final') return scout({ diffLines: 30, headSha: SHA(2) })
    if (label === 'final:correctness') return { findings: [finding(), finding({ line: 40, verdict: 'PLAUSIBLE', summary: 'plausible one' })] }
    if (label === 'fix:final') return done(SHA(3), { scout: scout({ diffLines: 2 }) })
    if (label === 'gate') return gateOk(SHA(3))
  })
  ok(!result.blocked, `not blocked: ${JSON.stringify(result.blocked)}`)
  eq(count(calls, 'scout:final'), 1, 'scout agent measured the range')
  eq(count(calls, 'assess'), 0, 'no assessor in the final review')
  eq(result.knownNotFixed.map(f => f.summary), ['plausible one'], 'PLAUSIBLE → known')
  eq(result.fixed.map(f => f.summary), ['off by one'], 'CONFIRMED fixed')
  eq(result.unreviewedFix, { stage: 'final', count: 1 }, 'final fix flagged unreviewed')
  const reverify = calls.filter(c => c.label.startsWith('verify:')).slice(2).map(c => c.label)
  eq(reverify, ['verify:web'], 'only the surface with flows re-verified')
  eq(result.headSha, SHA(3), 'gate ran on the final fix')
})

await test('gate: dirty tree and red suite are not resumable; HEAD mismatch is', async () => {
  const dirty = await run(verifyArgs(), label => { if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2']); if (label === 'gate') return { ...gateOk(SHA(1)), porcelain: ['?? .scratch/', ' M src/a.ts'] } })
  eq(dirty.result.blocked.stage, 'gate', 'blocked'); eq(dirty.result.blocked.resumable, false, 'dirty not resumable'); eq(dirty.result.gate.dirty, [' M src/a.ts'], 'scratch excepted')
  const red = await run(verifyArgs(), label => { if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2']); if (label === 'gate') return { ...gateOk(SHA(1)), testExit: 1 } })
  eq(red.result.blocked.resumable, false, 'red not resumable')
  const head = await run(verifyArgs(), label => { if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2']); if (label === 'gate') return gateOk(SHA(9)) })
  eq(head.result.blocked.resumable, true, 'wrong HEAD resumable')
  const died = await run(verifyArgs(), label => { if (label.startsWith('verify:')) return verifyOk('web', ['C1', 'C2']) })
  eq(died.result.blocked.resumable, true, 'dead gate resumable')
})

await test('skipVerify goes straight to the gate', async () => {
  const { calls, result } = await run(verifyArgs({ skipVerify: true }), label => { if (label === 'gate') return gateOk(SHA(1)) })
  eq(calls.map(c => c.label), ['gate'], 'only the gate ran'); eq(result.verify.ran, false, 'recorded as skipped')
})

await test('bad args throw before any agent runs', async () => {
  for (const [name, a] of [['criteria objects', verifyArgs({ criteria: [{ text: 'x' }] })], ['empty criterion', verifyArgs({ criteria: [''] })], ['bad surface', verifyArgs({ surfaces: ['desktop'] })], ['no scoutScript', buildArgs({ scoutScript: undefined })], ['empty seams', buildArgs({ seams: [] })]]) {
    let threw = false
    try { await run(a, () => { throw new Error('agent should not run') }) } catch (e) { threw = /args\./.test(e.message) }
    ok(threw, `${name} throws an args error`)
  }
})

// ================================================================ scout.sh triggers
console.log('scout.sh')

const scoutSh = join(here, '..', '..', 'reference', 'scout.sh')
const sh = (cwd, cmd, args = []) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const git = (cwd, ...a) => sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a])
function scoutRepo(write) {
  const dir = mkdtempSync(join(tmpdir(), 'scout-test-'))   // never inside the repo
  try {
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'README'), 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
    write(dir)
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'change')
    return sh(dir, 'bash', [scoutSh, dir, 'HEAD~1..HEAD'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const billing = dir => { mkdirSync(join(dir, 'src/billing'), { recursive: true }); writeFileSync(join(dir, 'src/billing/invoice.ts'), 'export const total = 1\n') }

await test('a path outside the built-in triggers does not fire', () => {
  ok(/^FIRED: false$/m.test(scoutRepo(billing)), 'src/billing/ should not fire by default')
})
await test('.claude/security-trigger-paths adds a path trigger', () => {
  const out = scoutRepo(dir => { mkdirSync(join(dir, '.claude'), { recursive: true }); writeFileSync(join(dir, '.claude/security-trigger-paths'), '# comment\n\nsrc/billing/\n'); billing(dir) })
  ok(/^FIRED: true$/m.test(out), 'listed path should fire'); ok(/^REASON: path: src\/billing\/invoice\.ts$/m.test(out), 'reason names the path')
})
await test('security-trigger-paths: a last line without a trailing newline still counts', () => {
  const out = scoutRepo(dir => { mkdirSync(join(dir, '.claude'), { recursive: true }); writeFileSync(join(dir, '.claude/security-trigger-paths'), 'other/\nsrc/billing/'); billing(dir) })
  ok(/^FIRED: true$/m.test(out), 'unterminated last entry should fire')
})
await test('.claude/security-trigger-regex adds a content trigger', () => {
  const content = dir => { mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src/pay.py'), 'charge_card(amount)\n') }
  ok(/^FIRED: false$/m.test(scoutRepo(content)), 'no regex file: no fire')
  const out = scoutRepo(dir => { mkdirSync(join(dir, '.claude'), { recursive: true }); writeFileSync(join(dir, '.claude/security-trigger-regex'), 'charge_card\\(\n'); content(dir) })
  ok(/^FIRED: true$/m.test(out) && /^REASON: line: \+charge_card/m.test(out), 'regex should fire on the added line')
})
await test('an invalid .claude/security-trigger-regex fires with a config reason and keeps the built-in trigger', () => {
  const out = scoutRepo(dir => {
    mkdirSync(join(dir, '.claude'), { recursive: true }); writeFileSync(join(dir, '.claude/security-trigger-regex'), 'charge_card(\n')
    mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src/a.py'), 'harmless = 1\npassword = read()\n')
  })
  ok(/^FIRED: true$/m.test(out), 'should fire')
  ok(/^REASON: config: invalid \.claude\/security-trigger-regex$/m.test(out), 'config reason expected')
  ok(/^REASON: line: \+password = read\(\)$/m.test(out), 'built-in content trigger must still run')
  ok(!/^REASON: line: \+harmless/m.test(out), 'a harmless line must not match')
})
await test('an empty alternative in .claude/security-trigger-regex does not match every line', () => {
  const out = scoutRepo(dir => {
    mkdirSync(join(dir, '.claude'), { recursive: true }); writeFileSync(join(dir, '.claude/security-trigger-regex'), 'charge_card\\(|\n|refund_card\\(\n')
    mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src/pay.py'), 'harmless = 1\ncharge_card(1)\nrefund_card(2)\n')
  })
  ok(/^REASON: line: \+charge_card\(1\)$/m.test(out) && /^REASON: line: \+refund_card\(2\)$/m.test(out), 'both entries should fire')
  ok(!/^REASON: line: \+harmless/m.test(out), 'an empty alternative must not match every line')
  ok(!/^REASON: config:/m.test(out), 'a stripped empty alternative is not a config error')
})
await test('a .claude/security-trigger-regex that matches an empty line is refused', () => {
  const out = scoutRepo(dir => {
    mkdirSync(join(dir, '.claude'), { recursive: true }); writeFileSync(join(dir, '.claude/security-trigger-regex'), 'x*\n')
    writeFileSync(join(dir, 'README'), 'y\n')
  })
  ok(/^REASON: config: invalid \.claude\/security-trigger-regex$/m.test(out), 'config reason expected')
  ok(!/^REASON: line:/m.test(out), 'must not match every line')
})
await test('a "+++" file header never counts as an added line', () => {
  const out = scoutRepo(dir => { writeFileSync(join(dir, 'README'), 'y\n') })
  ok(!/^REASON:/m.test(out), 'no reasons for a plain README change')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
