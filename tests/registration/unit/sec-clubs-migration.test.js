import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const dir = new URL('../../../supabase/migrations/', import.meta.url)
const FILE = '20261111200000_club_hardening.sql'
const sql = async () => (await readFile(new URL(FILE, dir), 'utf8'))
  .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase()

test('club_hardening revokes table-wide SELECT and grants named columns only', async () => {
  const s = await sql()
  assert.match(s, /revoke select on public\.clubs from anon, authenticated;/)
  const grants = [...s.matchAll(/grant\s+select\s*(\(([^)]*)\))?\s+on\s+(table\s+)?public\.clubs\s+to\s+([^;]+);/g)]
  assert.equal(grants.length, 1)
  assert.ok(grants[0][2], 'the grant names its columns')
  const cols = grants[0][2].split(',').map((c) => c.trim())
  for (const forbidden of ['owner_id', 'pending_owner_id', 'registration_enabled']) {
    assert.ok(!cols.includes(forbidden), `${forbidden} granted`)
  }
  assert.ok(!/owner_id/.test(s), 'no owner column anywhere in the statements')
  assert.deepEqual(cols.sort(), ['id', 'logo_url', 'name', 'slug'])
})

test('upload-club-logo reads the header before decode and takes PNG/JPEG only', async () => {
  const src = await readFile(new URL('../../../supabase/functions/upload-club-logo/index.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ imageHeader \} from '\.\.\/_shared\/imageHeader\.js'/)
  const re = src.match(/const DATA_URL_RE = (.*)/)[1]
  assert.ok(!/webp/i.test(re), 'webp still in the data URL regex')
  assert.ok(src.indexOf('imageHeader(bytes)') < src.indexOf('Image.decode('), 'header check before decode')
  assert.match(src, /MAX_HEADER_PX = 4096/)
})

test('the club logo UI converts in the browser through logoResize', async () => {
  const src = await readFile(new URL('../../../public/src/components/ClubLogoUpload.jsx', import.meta.url), 'utf8')
  assert.match(src, /await logoResize\(file\)/)
  assert.ok(!/readAsDataURL/.test(src), 'raw file still sent')
})

test('transfer-ownership accept is conditional and demotes before it promotes', async () => {
  const src = await readFile(new URL('../../../supabase/functions/transfer-ownership/index.js', import.meta.url), 'utf8')
  const accept = src.slice(src.indexOf("op === 'accept'"), src.indexOf("op === 'decline'"))
  assert.match(accept, /\.eq\('pending_owner_id', session\.userId\)/)
  assert.match(accept, /transferred\?\.length/)
  const clubs = accept.indexOf('owner_id: session.userId, pending_owner_id: null')
  const demote = accept.indexOf("role: 'admin'")
  const promote = accept.indexOf("role: 'owner'")
  assert.ok(clubs > 0 && clubs < demote && demote < promote)
})

test('delete-club removes the logo object best effort', async () => {
  const src = await readFile(new URL('../../../supabase/functions/delete-club/index.js', import.meta.url), 'utf8')
  assert.match(src, /storage\.from\('club-logos'\)\.remove\(\[`\$\{club_id\}\/logo\.png`\]\)/)
  assert.ok(src.indexOf("remove([") > src.indexOf(".from('clubs').delete()"))
  assert.ok(!/if \(logoErr\) throw/.test(src))
})
