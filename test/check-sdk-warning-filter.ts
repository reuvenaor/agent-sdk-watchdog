/**
 * The SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning prints ONCE per process, and every other
 * warning keeps Node's own format. Measured in a CHILD process, because the filter wraps
 * `process.emitWarning` and Node's default printer runs on the process's own stderr — an
 * in-process check would see only what a listener sees, which is not what the operator sees.
 *
 * The first child installs the filter twice, the second time with a different callback, emits
 * the target code twice (once per `emitWarning` signature) and one other warning, and exits. The
 * second child passes its own `codes` and an `onFirst` that throws. Standalone:
 * `npx tsx test/check-sdk-warning-filter.ts`.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const filterUrl = pathToFileURL(path.join(pkgRoot, 'src/sdk-warning-filter.ts')).href

const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sdk-warning-'))
const probe = path.join(probeDir, 'probe.ts')
fs.writeFileSync(
  probe,
  `import { installSdkWarningFilter } from '${filterUrl}'
const first = installSdkWarningFilter({ onFirst: () => console.warn('[probe] note') })
const wrapped = process.emitWarning
const second = installSdkWarningFilter({ onFirst: () => console.warn('[probe] second') })
console.log(JSON.stringify({ first, second, sameWrapper: process.emitWarning === wrapped }))
process.emitWarning('canUseTool will not be invoked for: mcp__x__y', { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' })
process.emitWarning('canUseTool will not be invoked for: mcp__x__z', 'Warning', 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED')
process.emitWarning('something else entirely', { code: 'PC_PROBE_OTHER' })
setTimeout(() => {}, 50)
`,
)

/** Runs `file` in a child `tsx`: Node's own warning printer is only visible there. */
const runProbe = (file: string) =>
  spawnSync('npx', ['tsx', file], {
    cwd: pkgRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
const { stdout, stderr, status: exitCode } = runProbe(probe)

const codesProbe = path.join(probeDir, 'codes.ts')
fs.writeFileSync(
  codesProbe,
  `import { installSdkWarningFilter } from '${filterUrl}'
const seen: string[] = []
installSdkWarningFilter({
  codes: ['PC_A', 'PC_B'],
  onFirst: (_warning, code) => {
    seen.push(code)
    if (code === 'PC_B') throw new Error('boom')
  },
})
let threw = false
try {
  process.emitWarning('a-one', { code: 'PC_A' })
  process.emitWarning('a-two', { code: 'PC_A' })
  process.emitWarning('b-one', 'Warning', 'PC_B')
  process.emitWarning('b-two', { code: 'PC_B' })
} catch {
  threw = true
}
process.emitWarning('shadowed', { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' })
console.log(JSON.stringify({ seen, threw }))
setTimeout(() => {}, 50)
`,
)
const codesRun = runProbe(codesProbe)
fs.rmSync(probeDir, { recursive: true, force: true })

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
}
const lines = stderr.split('\n')
check('the probe ran', exitCode === 0, `exit ${exitCode}: ${stderr.slice(0, 300)}`)
check(
  'the shadowed warning is replaced by ONE note, for two emits through both signatures',
  lines.filter((l) => l.startsWith('[probe] note')).length === 1 &&
    !stderr.includes('canUseTool will not be invoked'),
  stderr.slice(0, 400),
)
check(
  "another warning keeps Node's own format and its trace hint",
  /\(node:\d+\) \[PC_PROBE_OTHER\] Warning: something else entirely/.test(stderr) &&
    stderr.includes('--trace-warnings'),
  stderr.slice(0, 400),
)
check(
  'installing twice wraps once (no double note, no double print)',
  lines.filter((l) => l.includes('PC_PROBE_OTHER')).length === 1,
)
let installs: { first?: unknown; second?: unknown; sameWrapper?: unknown } = {}
try {
  installs = JSON.parse(stdout.trim()) as typeof installs
} catch {
  // Left empty: the checks below then fail and print the raw stdout.
}
check('the first install reports true', installs.first === true, stdout)
check('a second install reports false', installs.second === false, stdout)
check(
  "a second install's callback never runs",
  !stderr.includes('[probe] second'),
  stderr.slice(0, 400),
)
check(
  'a second install leaves emitWarning as the first wrapper',
  installs.sameWrapper === true,
  stdout,
)

let codes: { seen?: unknown; threw?: unknown } = {}
try {
  codes = JSON.parse(codesRun.stdout.trim()) as typeof codes
} catch {
  // Left empty: the checks below then fail and print the raw stdout.
}
check('codes: the probe ran', codesRun.status === 0, codesRun.stderr.slice(0, 300))
check(
  'codes: onFirst runs once per code, with the code',
  JSON.stringify(codes.seen) === '["PC_A","PC_B"]',
  codesRun.stdout,
)
check('codes: a throwing onFirst is dropped', codes.threw === false, codesRun.stdout)
check(
  'codes: every warning of a listed code is swallowed',
  !/[ab]-(one|two)/.test(codesRun.stderr),
  codesRun.stderr.slice(0, 400),
)
check(
  'codes: a code left off the list prints as usual',
  codesRun.stderr.includes('[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: shadowed'),
  codesRun.stderr.slice(0, 400),
)

if (failures > 0) {
  console.error(`\ncheck-sdk-warning-filter: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\ncheck-sdk-warning-filter: all checks pass')
