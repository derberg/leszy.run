// Usage: cd backend && node --env-file=../.env scripts/purge-registration-contact.js [--apply]
//
// Phone numbers of people who registered online are kept for 30 days after the
// event. Supabase does that itself (purge_registration_contact_data(), pg_cron),
// but a timing host owns its copy of participants.phone after the registration
// closes, so the operator runs this on each host after the race (spec 14.21).
// Only participants with a registration_id are touched: a phone typed in by hand
// or imported is not covered by the registration retention rule. The names of
// teams set up on the hosts (host_teams) are replaced with the neutral
// „Drużyna 1A2B3C4D” after the same 30 days, as Supabase does.
//
// Dry run by default; --apply nulls the numbers. The write goes through Drizzle,
// so the sync trigger resets synced_at and the push worker sends the nulls.

import { db } from '../src/db/index.js'
import { purgeRegistrationContact, purgeHostTeamNames } from './lib/purgeRegistrationContact.js'

const apply = process.argv.includes('--apply')
const { cutoff, count } = await purgeRegistrationContact(db, { apply })
console.log(`participants: ${count} registration participant(s) with a phone, event date <= ${cutoff}${apply ? ' (phone nulled)' : ' (dry run, pass --apply to null them)'}`)
const teams = await purgeHostTeamNames(db, { apply })
console.log(`host_teams: ${teams.count} team name(s), event date <= ${teams.cutoff}${apply ? ' (replaced with a neutral name)' : ' (dry run, pass --apply to replace them)'}`)
process.exit(0)
