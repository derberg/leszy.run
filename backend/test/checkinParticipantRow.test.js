import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkinParticipantRow } from '../src/lib/checkinParticipantRow.js'
import { PUSH_EXCLUDED_COLUMNS } from '../src/sync/supabase.js'

test('admin check-in upsert never carries a Supabase-owned participants column', () => {
  const row = checkinParticipantRow({
    id: 'p1', eventId: 'e1', firstName: 'Jan', lastName: 'Kowalski', bibNumber: 7, categoryId: 'c1',
    email: 'jan@example.com', phone: '+48500000000', gender: 'M', birthDate: '1990-01-01', club: 'X',
    rfidEpc: 'E1', emoji: '🦊', tshirtSize: 'M',
    registrationId: 'r1', removedAt: new Date(), // owned by Supabase: must not be pushed
  })
  for (const c of PUSH_EXCLUDED_COLUMNS.participants) assert.equal(c in row, false, `${c} pushed`)
  assert.deepEqual(Object.keys(row).sort(), [
    'bib_number', 'birth_date', 'category_id', 'club', 'email', 'emoji', 'event_id', 'first_name',
    'gender', 'id', 'last_name', 'phone', 'rfid_epc', 'tshirt_size',
  ])
  assert.deepEqual([...PUSH_EXCLUDED_COLUMNS.participants].sort(), ['registration_id', 'removed_at'])
})
