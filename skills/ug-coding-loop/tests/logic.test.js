// Standalone checks for the pure logic in ../scripts/build_verify_loop.js.
// The script itself only runs inside the Workflow sandbox, so the pure
// functions are copied here VERBATIM and the inline loop blocks are
// replicated exactly. If you edit the script, update the copies and run:
//
//   node skills/ug-coding-loop/tests/logic.test.js
//
// No framework, exits non-zero on the first failed assertion.
const assert = require('assert')

// ---- copied verbatim from build_verify_loop.js ----------------------------
const itemFiles = (it) => (it.files || []).map(f => f.replace(/^\.\//, ''))
const issueFile = (iss) => {
  const w = String(iss.where || iss.file || '').trim()
  const tok = w.split(/[\s(]/)[0]
  const path = tok.split(':')[0]
  return /[./]/.test(path) ? path.replace(/^\.\//, '') : ''
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40)
const collectIssues = (verdicts) => {
  const seen = new Set()
  return verdicts.filter(Boolean).flatMap(v => (v.blocking_issues || []).map(i =>
    typeof i === 'string' ? { problem: i } : i))
    .filter(i => {
      const key = (issueFile(i) || norm(i.where)) + '|' + norm(i.criterion)
      if (key === '|') return true
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
const SMOKE_PATH_RE = /[\p{L}\p{N}_@./-]+\.[A-Za-z]{1,4}(?::\d+)?/gu
const extractPaths = (text) => [...new Set((String(text || '').match(SMOKE_PATH_RE) || [])
  .map(t => t.split(':')[0].replace(/^\.\//, ''))
  .filter(Boolean))]
const ownersOf = (file, items) => !file ? [] :
  items.filter(it => itemFiles(it).some(of =>
    of === file || of.endsWith('/' + file) || file.endsWith('/' + of)))
const planRework = (items, fixList, forceAll) => {
  if (!fixList) return items.map((it) => ({ item: it, issues: null }))
  const attributed = fixList.map(iss => ({ iss, owners: ownersOf(issueFile(iss), items).map(it => it.id) }))
  const fileless = new Set(items.filter(it => itemFiles(it).length === 0).map(it => it.id))
  const fallbackAll = forceAll || attributed.length === 0 || attributed.some(a => a.owners.length === 0)
  const pool = fallbackAll ? items : items.filter(it =>
    fileless.has(it.id) || attributed.some(a => a.owners.includes(it.id)))
  return pool.map(it => ({
    item: it,
    issues: attributed
      .filter(a => forceAll || a.owners.includes(it.id) || fileless.has(it.id) || (fallbackAll && a.owners.length === 0))
      .map(a => a.iss),
  }))
}
const TESTS_RUN_CAP = 600
const forGraders = (builds) => (builds || []).map(b => {
  const t = String(b.tests_run || '')
  return t.length <= TESTS_RUN_CAP ? b
    : { ...b, tests_run: `${t.slice(0, TESTS_RUN_CAP)}\n…[${t.length - TESTS_RUN_CAP} chars trimmed — re-run the commands yourself; do not grade on this report]` }
})
const dedupeOutputs = (list) => {
  const seen = new Set()
  return list.map(iss => {
    if (!iss.output) return iss
    if (seen.has(iss.output)) return { ...iss, output: '(same failing output as the issue above)' }
    seen.add(iss.output)
    return iss
  })
}
let lastSig = null, lastCount = Infinity, sigRepeats = 0, forceFullRework = false
const resetStall = () => { lastSig = null; lastCount = Infinity; sigRepeats = 0; forceFullRework = false }
const issueSig = (list) => JSON.stringify([...new Set(list.map(i =>
  issueFile(i) || norm(i.criterion) || norm(i.where)))].sort())
const trackStall = (list) => {
  const sig = issueSig(list)
  if (sig === lastSig && list.length >= lastCount) sigRepeats++
  else sigRepeats = 0
  lastSig = sig
  lastCount = list.length
  if (sigRepeats >= 2) return true
  forceFullRework = sigRepeats === 1
  return false
}
// ---- end verbatim copies --------------------------------------------------

// ---- replicated inline blocks ---------------------------------------------
// Smoke-fail branch over the same inputs the script has at that point.
// smokeReds doubles as attribution state: only reds === 0 may target.
const SMOKE_CMD = 'npm test'
const smokeFixList = (smoke, items, smokeReds) => {
  const evidence = (smoke.evidence || '').slice(0, 4000)
  const keepOwned = (paths) => [...new Set(paths.map(f => String(f).replace(/^\.\//, '')).filter(Boolean))]
    .filter(p => ownersOf(p, items).length > 0)
  let owned = smokeReds === 0 ? keepOwned(smoke.implicated_files || []) : []
  if (smokeReds === 0 && !owned.length) owned = keepOwned(extractPaths(smoke.evidence))
  const fixList = owned.length ? owned.map(f => ({
    problem: `Objective check failed: ${SMOKE_CMD} — failure implicates this file`,
    where: f,
    fix: 'Make this command pass. Its raw failing output follows — work from it.',
    output: evidence,
  })) : [{
    problem: `Objective check failed: ${SMOKE_CMD}`,
    where: 'smoke gate (pre-review)',
    fix: 'Make this command pass. Its raw failing output follows — work from it.',
    output: evidence,
  }]
  return { fixList, owned }
}
// Plan-intake id uniquify.
const uniquify = (work_items) => {
  const seen = new Set()
  work_items.forEach((it, i) => {
    let id = String(it.id || '') || `item-${i + 1}`
    while (seen.has(id)) id = `${id}-dup`
    seen.add(id)
    it.id = id
  })
  return work_items
}
// Post-build changed_files adoption.
const adopt = (it, build, items, warnings) => {
  for (const raw of (build.changed_files || [])) {
    const f = String(raw).replace(/^\.\//, '')
    if (!f || itemFiles(it).includes(f)) continue
    const other = ownersOf(f, items).filter(o => o !== it)
    if (other.length) warnings.push(`warning: ${it.id} changed ${f}, owned by ${other[0].id} — disjoint-files invariant violated.`)
    else (it.files = it.files || []).push(f)
  }
}
// Numeric knob coercion.
const _num = (v) => v == null ? NaN : Number(v)
const maxCyclesOf = (v) => Math.max(1, Number.isFinite(_num(v)) ? _num(v) : 10)
const budgetFloorOf = (v) => Number.isFinite(_num(v)) ? _num(v) : 40000
// ---- end replicated blocks ------------------------------------------------

const ITEMS = () => [
  { id: 'i1', title: 'foo', files: ['src/foo.ts'] },
  { id: 'i2', title: 'bar', files: ['src/bar.ts', 'src/bar.test.ts'] },
  { id: 'i3', title: 'docs', files: ['README.md'] },
]
const ids = (jobs) => jobs.map(j => j.item.id).sort()
let passed = 0
const ok = (label) => { passed++; console.log(`${String(passed).padStart(2)}) ${label}  PASS`) }

// --- smoke attribution -----------------------------------------------------
{
  const items = ITEMS()
  let r = smokeFixList({ green: false, evidence: 'FAIL src/foo.ts:12:4 TypeError\n  at src/foo.ts:12' }, items, 0)
  assert.deepStrictEqual(r.fixList.map(f => f.where), ['src/foo.ts'])
  assert.deepStrictEqual(ids(planRework(items, r.fixList)), ['i1'])
  ok('smoke evidence names src/foo.ts -> rework only its owner')

  r = smokeFixList({ green: false, evidence: 'exit 1', implicated_files: ['./src/bar.ts'] }, items, 0)
  assert.deepStrictEqual(ids(planRework(items, r.fixList)), ['i2'])
  ok('agent-reported implicated_files targets the owner')

  r = smokeFixList({ green: false, evidence: 'src/foo.ts:1 bad\nREADME.md:3 bad\n/etc/hosts noise' }, items, 0)
  const jobs = planRework(items, r.fixList)
  assert.deepStrictEqual(ids(jobs), ['i1', 'i3'])
  assert.deepStrictEqual(jobs.map(j => j.issues.map(i => i.where)), [['src/foo.ts'], ['README.md']])
  ok('regex sweep: two owned paths -> two owners, scoped issues')

  r = smokeFixList({ green: false, evidence: 'PASS src/bar.ts\nFAIL src/foo.ts:12', implicated_files: ['src/foo.ts'] }, items, 0)
  assert.deepStrictEqual(ids(planRework(items, r.fixList)), ['i1'])
  ok('agent list beats sweep noise (passing-test summary ignored)')

  r = smokeFixList({ green: false, evidence: 'FAIL src/foo.ts:12', implicated_files: ['node_modules/x/y.js'] }, items, 0)
  assert.deepStrictEqual(ids(planRework(items, r.fixList)), ['i1'])
  ok('unowned agent list -> sweep backstop saves attribution')

  r = smokeFixList({ green: false, evidence: 'Segmentation fault\nexit code 139' }, items, 0)
  assert.deepStrictEqual(r.fixList.map(f => f.where), ['smoke gate (pre-review)'])
  assert.deepStrictEqual(ids(planRework(items, r.fixList)), ['i1', 'i2', 'i3'])
  ok('no recognizable path -> nameless issue, full re-run')

  r = smokeFixList({ green: false, evidence: 'node_modules/left-pad/index.js:4 boom' }, items, 0)
  assert.deepStrictEqual(ids(planRework(items, r.fixList)), ['i1', 'i2', 'i3'])
  ok('only unowned paths -> full re-run')

  // consecutive reds: reds>0 forces nameless regardless of evidence; 3rd stops
  r = smokeFixList({ green: false, evidence: 'FAIL src/foo.ts:12 still broken' }, items, 1)
  assert.deepStrictEqual(r.fixList.map(f => f.where), ['smoke gate (pre-review)'])
  r = smokeFixList({ green: false, evidence: 'FAIL src/foo.ts:12 still broken' }, items, 2)
  assert.deepStrictEqual(r.fixList.map(f => f.where), ['smoke gate (pre-review)'])
  let smokeReds = 2
  smokeReds++
  assert.ok(smokeReds >= 3)   // script stops as 'stalled' here
  ok('2nd+ consecutive red -> sticky full re-run; 3rd stops the run')

  assert.deepStrictEqual(extractPaths('File "src/héllo.py", line 3'), ['src/héllo.py'])
  assert.deepStrictEqual(extractPaths('FAIL tests/日本語.test.ts:12'), ['tests/日本語.test.ts'])
  ok('unicode filenames extract whole')
}

// --- reviewer-issue targeting ----------------------------------------------
{
  const items = ITEMS()
  assert.deepStrictEqual(ids(planRework(items, [{ problem: 'p', where: 'src/bar.ts:88', fix: 'f' }])), ['i2'])
  assert.deepStrictEqual(ids(planRework(items, [{ where: 'src/foo.ts:1' }, { where: 'src/bar.test.ts' }])), ['i1', 'i2'])
  assert.deepStrictEqual(ids(planRework(items, [{ where: 'LoginButton component' }])), ['i1', 'i2', 'i3'])
  const mixed = planRework(items, [{ where: 'src/foo.ts' }, { where: 'LoginButton' }])
  assert.deepStrictEqual(ids(mixed), ['i1', 'i2', 'i3'])
  assert.strictEqual(mixed.find(j => j.item.id === 'i2').issues.length, 1)   // nameless goes to everyone
  assert.deepStrictEqual(planRework(items, null).map(j => j.issues), [null, null, null])
  ok('reviewer issues: owner-only, multi, component, mixed, first build')

  assert.deepStrictEqual(ownersOf('app.py', [{ id: 'w', files: ['webapp.py'] }]), [])
  assert.deepStrictEqual(ownersOf('app.py', [{ id: 'a', files: ['src/app.py'] }]).map(i => i.id), ['a'])
  assert.deepStrictEqual(ownersOf('repo/src/app.py', [{ id: 'a', files: ['src/app.py'] }]).map(i => i.id), ['a'])
  ok('ownersOf: / boundary, no webapp.py/app.py false match')

  const withFileless = [{ id: 'i1', files: ['src/foo.ts'] }, { id: 'i2', files: ['src/bar.ts'] }, { id: 'x' }]
  const jf = planRework(withFileless, [{ where: 'src/foo.ts:3' }])
  assert.deepStrictEqual(ids(jf), ['i1', 'x'])                               // i2 carried forward
  assert.strictEqual(jf.find(j => j.item.id === 'x').issues.length, 1)
  ok('fileless item always re-runs but does not drag attributed items')

  const jForce = planRework(ITEMS(), [{ where: 'src/foo.ts:3', problem: 'p' }], true)
  assert.deepStrictEqual(ids(jForce), ['i1', 'i2', 'i3'])
  assert.strictEqual(jForce.find(j => j.item.id === 'i3').issues.length, 1)  // everyone sees every issue
  ok('forceAll: all coders run, all issues to all')
}

// --- issue collection & prompts --------------------------------------------
{
  const vA = { pass: false, blocking_issues: [{ criterion: 'npm test passes', problem: 'test X fails', where: 'src/foo.ts:5', fix: 'f' }] }
  const vB = { pass: false, blocking_issues: [{ criterion: 'npm test passes', problem: 'X assertion broken', where: 'src/foo.ts:7', fix: 'g' }] }
  assert.strictEqual(collectIssues([vA, vB]).length, 1)                       // cross-lane dupe collapses
  const vC = { pass: false, blocking_issues: [
    { criterion: 'c1', problem: 'p1', where: 'src/foo.ts:1', fix: 'f' },
    { criterion: 'c2', problem: 'p2', where: 'src/foo.ts:2', fix: 'f' }] }
  assert.strictEqual(collectIssues([vC]).length, 2)                           // distinct criteria survive
  assert.strictEqual(collectIssues([null, vA]).length, 1)                     // dead verdict skipped
  ok('collectIssues: lane dedupe by file+criterion, dead lanes skipped')

  const out = dedupeOutputs([
    { where: 'a.ts', output: 'BLOB' }, { where: 'b.ts', output: 'BLOB' },
    { where: 'c.ts', output: 'OTHER' }, { where: 'd.ts' }])
  assert.strictEqual(out[1].output, '(same failing output as the issue above)')
  assert.strictEqual(out[0].output, 'BLOB')
  assert.strictEqual(out[3].output, undefined)
  ok('dedupeOutputs: one copy per identical blob')

  const short = { item_id: 'a', tests_run: 'npm test -> OK' }
  const long = { item_id: 'b', summary: 'kept', tests_run: 'x'.repeat(5000) }
  const graded = forGraders([short, long, { item_id: 'c' }])
  assert.strictEqual(graded[0], short)                                       // untouched, same object
  assert.ok(graded[1].tests_run.length < 800)                                // capped
  assert.ok(graded[1].tests_run.startsWith('x'.repeat(600)))                 // head kept
  assert.ok(graded[1].tests_run.includes('4400 chars trimmed'))
  assert.strictEqual(graded[1].summary, 'kept')                              // other fields intact
  assert.strictEqual(long.tests_run.length, 5000)                            // source not mutated
  assert.strictEqual(graded[2].tests_run, undefined)                         // missing field safe
  assert.deepStrictEqual(forGraders(null), [])
  ok('forGraders: caps tests_run for graders, leaves source untouched')
}

// --- stall detection --------------------------------------------------------
{
  resetStall()
  const verifyIssues = [{ where: 'src/app.py:10', problem: 'a' }]
  trackStall(verifyIssues)
  trackStall(verifyIssues)
  assert.strictEqual(forceFullRework, true)                                   // escalate at repeat
  resetStall()                                                                // verify gate PASSED
  assert.strictEqual(trackStall([{ where: 'src/app.py:99', problem: 'new bless issue' }]), false)
  assert.strictEqual(forceFullRework, false)
  ok('gate pass resets tracker: bless 1st reject never swallowed as stall')

  resetStall()
  const at = (n) => Array.from({ length: n }, (_, i) => ({ where: `src/only.ts:${i}`, problem: `p${i}` }))
  assert.strictEqual(trackStall(at(5)), false)
  assert.strictEqual(trackStall(at(2)), false)                                // shrinking = progress
  assert.strictEqual(forceFullRework, false)
  assert.strictEqual(trackStall(at(1)), false)
  assert.strictEqual(trackStall(at(1)), false)                                // repeat -> escalate
  assert.strictEqual(forceFullRework, true)
  assert.strictEqual(trackStall(at(1)), true)                                 // stuck -> stall
  ok('shrinking count is progress; equal count repeats escalate then stop')

  resetStall()
  const p1 = [{ criterion: 'login flow works', where: 'the login handler component', problem: 'x' }]
  const p2 = [{ criterion: 'login flow works', where: 'login handler (auth flow)', problem: 'y' }]
  assert.strictEqual(issueSig(p1), issueSig(p2))                              // criterion is the stable key
  const c1 = [{ where: 'src/auth.ts:42', problem: 'token expiry uses <' }]
  const c2 = [{ where: 'src/auth.ts:44', problem: 'off-by-one at boundary' }]
  assert.strictEqual(issueSig(c1), issueSig(c2))                              // file survives rewording
  assert.notStrictEqual(issueSig(c1), issueSig([{ where: 'src/other.ts:1', problem: 'z' }]))
  ok('issueSig: prose-proof via file, criterion fallback for pathless')
}

// --- plan intake & build bookkeeping ----------------------------------------
{
  const items = uniquify([{ id: 'a' }, { id: 'a' }, {}, { id: 'item-3' }])
  assert.deepStrictEqual(items.map(i => i.id), ['a', 'a-dup', 'item-3', 'item-3-dup'])
  ok('id uniquify: duplicates and gaps all end distinct')

  const its = [{ id: 'i1', files: ['src/foo.ts'] }, { id: 'i2', files: ['src/bar.ts'] }]
  const warnings = []
  adopt(its[0], { changed_files: ['./src/foo.ts', 'src/foo.test.ts', 'src/bar.ts'] }, its, warnings)
  assert.deepStrictEqual(its[0].files, ['src/foo.ts', 'src/foo.test.ts'])
  assert.strictEqual(warnings.length, 1)
  assert.ok(warnings[0].includes('owned by i2'))
  assert.deepStrictEqual(ownersOf('src/foo.test.ts', its).map(i => i.id), ['i1'])
  ok('changed_files: new files adopted, cross-owned refused with warning')

  const jobsAll = [{ item: { id: 'i1' } }, { item: { id: 'i2' } }, { item: { id: 'i3' } }]
  const done = new Set(['i1', 'i3'])
  const remaining = jobsAll.filter(jb => !done.has(jb.item.id))
  assert.deepStrictEqual(remaining.map(j => j.item.id), ['i2'])
  assert.deepStrictEqual([...new Set([...done, ...remaining.map(jb => jb.item.id)])].sort(), ['i1', 'i2', 'i3'])
  ok('dead-coder resume: only missing items rebuild, rework note covers all')

  assert.strictEqual(maxCyclesOf('5'), 5)
  assert.strictEqual(maxCyclesOf(undefined), 10)
  assert.strictEqual(maxCyclesOf(0), 1)
  assert.strictEqual(budgetFloorOf('0'), 0)
  assert.strictEqual(budgetFloorOf(undefined), 40000)
  ok('numeric knobs coerce from strings, explicit 0 floor honored')
}

console.log(`\nall ${passed} checks passed`)
