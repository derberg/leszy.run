// Test-stack slots: several independent local Supabase stacks on one machine, so
// two worktrees (or two agents) can run the registration tests at the same time.
//
// Slot 0 is the stack `supabase start` makes from supabase/config.toml, with the
// ports everyone already uses; it is what you get when REG_TEST_SLOT is unset,
// and what CI runs. Slot n >= 1 is made by `scripts/test-slot.sh n …` from a copy
// of config.toml in .supabase-slots/<n>/ with its own project_id and every port
// moved up by n x 100. Every port a test uses is derived here from that one number.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SLOT_STEP = 100
export const MAX_SLOT = 9

/** The slot this process tests against: REG_TEST_SLOT, default 0. */
export function testSlot(env = process.env) {
  const raw = env.REG_TEST_SLOT
  if (raw === undefined || raw === '') return 0
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_SLOT) {
    throw new Error(`REG_TEST_SLOT must be an integer 0..${MAX_SLOT}, got "${raw}"`)
  }
  return Number(raw)
}

/** A slot-0 port moved to `slot`. */
export function slotPort(base, slot = testSlot()) {
  return base + slot * SLOT_STEP
}

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The --workdir for `supabase` in this slot, or null for slot 0 (the repo itself). */
export function slotWorkdir(slot = testSlot()) {
  return slot === 0 ? null : join(REPO_ROOT, '.supabase-slots', String(slot))
}

// Slot-0 ports of the processes the tests start themselves.
export const EMAIL_CAPTURE_BASE_PORT = 54399
export const SCRATCH_PG_BASE_PORT = 55432
export const VITE_BASE_PORT = 5174
