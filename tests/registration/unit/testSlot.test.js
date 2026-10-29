// Test-stack slots (scripts/test-slot.sh): slot 0 is today's stack, slot n moves every port by n x 100.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('no slot port lands on another slot family (email capture, scratch Postgres, Vite)', () => {
  const ports = new Map()
  for (let n = 0; n <= 9; n++) {
    const own = [
      ...DEFAULT_PORTS.map(([, , base]) => slotPort(base, n)),
      slotPort(54399, n), slotPort(55432, n), slotPort(5174, n),
    ]
    for (const p of own) {
      assert.ok(!ports.has(p), `port ${p} of slot ${n} also belongs to slot ${ports.get(p)}`)
      ports.set(p, n)
    }
  }
})
