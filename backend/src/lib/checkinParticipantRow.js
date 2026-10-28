import { PUSH_EXCLUDED_COLUMNS } from '../sync/supabase.js'

// The participants row the admin check-in upserts into Supabase before the checkin
// (FK). An explicit field list: it must never carry a column Supabase owns
// (PUSH_EXCLUDED_COLUMNS.participants: registration_id, removed_at). A PostgREST
// upsert only writes the columns in the payload, so leaving them out keeps
// Supabase's value; sending removed_at = NULL would un-remove a runner removed online.
export function checkinParticipantRow(p) {
  const row = {
    id: p.id,
    event_id: p.eventId,
    first_name: p.firstName,
    last_name: p.lastName,
    bib_number: p.bibNumber,
    category_id: p.categoryId,
    email: p.email,
    phone: p.phone,
    gender: p.gender,
    birth_date: p.birthDate,
    club: p.club,
    rfid_epc: p.rfidEpc,
    emoji: p.emoji,
    tshirt_size: p.tshirtSize,
  }
  for (const c of PUSH_EXCLUDED_COLUMNS.participants) delete row[c]
  return row
}
