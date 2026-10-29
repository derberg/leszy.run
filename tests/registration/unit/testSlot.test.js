// Test-stack slots (scripts/test-slot.sh): slot 0 is today's stack, slot n moves every port by n x 100.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testSlot, slotPort, slotWorkdir, REPO_ROOT } from '../helpers/slot.js'
import { slotConfig, DEFAULT_PORTS } from '../helpers/slotConfig.js'

const here = dirname(fileURLToPath(import.meta.url))
const realConfig = readFileSync(join(here, '../../../supabase/config.toml'), 'utf8')

test('no REG_TEST_SLOT is slot 0: the same ports and no --workdir', () => {
  assert.equal(testSlot({}), 0)
  assert.equal(testSlot({ REG_TEST_SLOT: '' }), 0)
  assert.equal(slotPort(54399, 0), 54399)
  assert.equal(slotPort(55432, 0), 55432)
  assert.equal(slotWorkdir(0), null)
})

test('slot n moves a port by n x 100 and works in .supabase-slots/<n>', () => {
  assert.equal(testSlot({ REG_TEST_SLOT: '2' }), 2)
  assert.equal(slotPort(54399, 2), 54599)
  assert.equal(slotPort(5174, 1), 5274)
  assert.equal(slotWorkdir(3), join(REPO_ROOT, '.supabase-slots', '3'))
})

test('a malformed REG_TEST_SLOT is refused rather than read as 0', () => {
  for (const v of ['x', '-1', '1.5', '10']) assert.throws(() => testSlot({ REG_TEST_SLOT: v }))
})

test('the slot config renames the project and moves every default port', () => {
  const out = slotConfig(realConfig, 3)
  assert.match(out, /^project_id = "kojoxazlnxncrpxmnxiq-s3"$/m)
  for (const [, key, base] of DEFAULT_PORTS) {
    assert.match(out, new RegExp(`^${key} = ${base + 300}$`, 'm'), `${key} = ${base + 300}`)
  }
  // Function blocks are kept as they are.
  assert.match(out, /^entrypoint = "\.\/functions\/auth-me\/index\.js"$/m)
})

test('a port the config already sets is moved in place, not duplicated', () => {
  const toml = 'project_id = "p"\n\n[api]\nenabled = true\nport = 60000\n\n[db]\nmajor_version = 17\n'
  const out = slotConfig(toml, 1)
  assert.equal(out.match(/^\[api\]$/gm).length, 1)
  assert.match(out, /^port = 60100$/m)
  assert.doesNotMatch(out, /^port = 54421$/m)
  assert.equal(out.match(/^\[db\]$/gm).length, 1)
  assert.match(out, /\[db\]\nport = 54422\nshadow_port = 54420\nmajor_version = 17/)
})

test('no slot port lands on another slot family (email capture, dpay mock, scratch Postgres, Vite)', () => {
  const ports = new Map()
  for (let n = 0; n <= 9; n++) {
    const own = [
      ...DEFAULT_PORTS.map(([, , base]) => slotPort(base, n)),
      slotPort(54399, n), slotPort(54398, n), slotPort(55432, n), slotPort(5174, n),
    ]
    for (const p of own) {
      assert.ok(!ports.has(p), `port ${p} of slot ${n} also belongs to slot ${ports.get(p)}`)
      ports.set(p, n)
    }
  }
})

test('the slot functions.env moves the e-mail capture, the dpay mock and the IPN URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slot-env-'))
  const out = execFileSync('bash', ['-c', `sed -n '/^  capture=/,/functions.env"$/p' "${join(REPO_ROOT, 'scripts/test-slot.sh')}"`], { encoding: 'utf8' })
  assert.match(out, /54398/)
  const script = `slot=2; reg="${join(REPO_ROOT, 'tests/registration')}"; dir="${dir}"\n${out}`
  execFileSync('bash', ['-c', script])
  const env = readFileSync(join(dir, 'functions.env'), 'utf8')
  assert.match(env, /^EMAIL_CAPTURE_URL=http:\/\/host\.docker\.internal:54599\/send$/m)
  assert.match(env, /^DPAY_API_BASE=http:\/\/host\.docker\.internal:54598$/m)
  assert.match(env, /^DPAY_PANEL_BASE=http:\/\/host\.docker\.internal:54598$/m)
  assert.match(env, /^DPAY_IPN_URL=http:\/\/127\.0\.0\.1:54521\/functions\/v1\/dpay-ipn$/m)
  rmSync(dir, { recursive: true, force: true })
})
