// Usage: cd backend && node --env-file=../.env scripts/publish-club-pages.js [--apply]
// Reads public clubs from Supabase and writes a committed manifest consumed by
// public/scripts/generate-club-pages.js at build time, which pre-renders
// dist/klub/:slug/index.html static pages.
//
// This REPLACES the deployed `render-club` Supabase edge function SSR approach —
// the Supabase edge runtime forces `text/plain` on HTML responses (see the comment
// in supabase/functions/render-club/index.js), which breaks crawlers/JSON-LD parsing.
// Static generation, like /kalendarz/:slug and /events/:slug, sidesteps that entirely.
// NOTE: `render-club` is still deployed on Supabase as of this writing but is now an
// unused orphan — nothing routes to it (public/vercel.json's rewrite was removed).
// It is harmless to leave, but can be removed manually with:
//   supabase functions delete render-club
//
// Dry run by default — use --apply to write the manifest.

import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const KLUB_DIR = resolve(PROJECT_ROOT, 'public/public/klub')
const MANIFEST_PATH = resolve(KLUB_DIR, '.manifest.json')

const dryRun = !process.argv.includes('--apply')

// Same masking rule as supabase/functions/render-club/index.js:
// hidden_public members are omitted entirely; visible ones are labeled by
// nickname when the member opted into privacy_settings.club_public_name === 'nickname',
// else display_name.
function visibleMemberLabels(members) {
  return members
    .filter((m) => !m.hidden_public)
    .map((m) => {
      const wantsNickname = m.profiles?.privacy_settings?.club_public_name === 'nickname'
      const primary = wantsNickname ? m.profiles?.nickname : m.profiles?.display_name
      return primary || m.profiles?.nickname || m.profiles?.display_name || 'Anonimowy zawodnik'
    })
}

async function main() {
  if (dryRun) console.log('=== DRY RUN (use --apply to write the manifest) ===\n')

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }
  const supabase = createClient(supabaseUrl, supabaseKey)

  // 1. Public clubs with a confirmed owner (owner_id IS NOT NULL excludes
  // clubs mid-transfer/ownerless-and-pending-deletion states).
  const { data: clubs, error: clubsErr } = await supabase
    .from('clubs')
    .select('id, name, slug, description, city, voivodeship, logo_url, owner_id, is_public')
    .eq('is_public', true)
    .not('owner_id', 'is', null)
    .order('name')
  if (clubsErr) { console.error('clubs fetch error:', clubsErr.message); process.exit(1) }

  if (!clubs || clubs.length === 0) {
    console.log('No public clubs found. Writing empty manifest.')
  }

  const { data: slugHistory } = await supabase
    .from('club_slug_history')
    .select('old_slug, club_id')
  const formerByClub = new Map()
  for (const row of slugHistory || []) {
    if (!formerByClub.has(row.club_id)) formerByClub.set(row.club_id, [])
    formerByClub.get(row.club_id).push(row.old_slug)
  }

  const manifest = []
  for (const club of clubs || []) {
    const { data: memberRows, error: memErr } = await supabase
      .from('club_members')
      .select('user_id, hidden_public, profiles(display_name, nickname, privacy_settings)')
      .eq('club_id', club.id)
      .eq('status', 'active')
    if (memErr) { console.error(`club_members fetch error for ${club.slug}:`, memErr.message); process.exit(1) }

    const allMembers = memberRows || []
    const visibleMembers = visibleMemberLabels(allMembers)

    manifest.push({
      id: club.id,
      name: club.name,
      slug: club.slug,
      description: club.description || null,
      city: club.city || null,
      voivodeship: club.voivodeship || null,
      logoUrl: club.logo_url || null,
      memberCount: allMembers.length,
      visibleMembers,
      formerSlugs: formerByClub.get(club.id) || [],
    })
  }

  const json = JSON.stringify(manifest, null, 2) + '\n'
  console.log(`Built manifest with ${manifest.length} public club(s).`)
  for (const c of manifest) {
    console.log(`  ${c.slug}: ${c.memberCount} member(s), ${c.visibleMembers.length} publicly visible`)
  }

  if (dryRun) {
    console.log(`\n(dry run) Would write ${MANIFEST_PATH}`)
    return
  }
  mkdirSync(KLUB_DIR, { recursive: true })
  writeFileSync(MANIFEST_PATH, json)
  console.log(`\nWrote ${MANIFEST_PATH}`)
}

main()
