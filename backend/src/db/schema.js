import { pgTable, uuid, text, integer, real, boolean, timestamp, bigint, jsonb, unique, date, numeric } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  date: text('date'),
  location: text('location'),
  rfidMode: text('rfid_mode').notNull().default('single'),        // 'single' | 'separate'
  rfidTopicMain: text('rfid_topic_main').notNull().default('leszyrun'),
  rfidTopicFinish: text('rfid_topic_finish').notNull().default('leszyrun/finish'),
  rssiThreshold: integer('rssi_threshold').notNull().default(-5000),
  declineThresholdCdbm: integer('decline_threshold_cdbm').notNull().default(1000),
  goneWindowSeconds: integer('gone_window_seconds').notNull().default(3),
  fallbackSeconds: integer('fallback_seconds').notNull().default(10),
  gunBackfillSeconds: integer('gun_backfill_seconds').notNull().default(60),
  slug: text('slug').notNull().unique(),
  publicResultsUrl: text('public_results_url'),
  eventUrl: text('event_url'),
  visibility: text('visibility').notNull().default('private'),  // 'private' | 'public'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),   // human-readable import key, e.g. 'bieg-5km'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
}, (t) => [
  unique().on(t.eventId, t.slug),
])

export const participants = pgTable('participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email'),
  gender: text('gender'),        // 'M' | 'K' | null
  birthDate: date('birth_date'),
  club: text('club'),
  bibNumber: integer('bib_number'),
  rfidEpc: text('rfid_epc'),    // hex EPC, e.g. '8A450224' (decoded from base64 at ingestion)
  emoji: text('emoji'),
  phone: text('phone'),
  smsSentAt: timestamp('sms_sent_at', { withTimezone: true }),
  tshirtSize: text('tshirt_size'),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
}, (t) => [
  unique().on(t.eventId, t.rfidEpc),
  unique().on(t.eventId, t.bibNumber),
])

export const raceRuns = pgTable('race_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').notNull().default('pending'),  // 'pending'|'active'|'finished'|'cancelled'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

export const gateEvents = pgTable('gate_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  raceRunId: uuid('race_run_id').references(() => raceRuns.id, { onDelete: 'set null' }),
  topic: text('topic').notNull(),
  epc: text('epc').notNull(),
  antennaPort: integer('antenna_port').notNull(),
  rssiCdbm: integer('rssi_cdbm').notNull(),
  frequency: integer('frequency'),
  raw: jsonb('raw').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  crossingId: uuid('crossing_id'),
})

export const gateCrossings = pgTable('gate_crossings', {
  id: uuid('id').primaryKey().defaultRandom(),
  raceRunId: uuid('race_run_id').notNull().references(() => raceRuns.id, { onDelete: 'cascade' }),
  participantId: uuid('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
  gate: text('gate').notNull(),          // 'start' | 'finish'
  crossingNumber: integer('crossing_number').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
  peakRssiCdbm: integer('peak_rssi_cdbm'),
  antennaPort: integer('antenna_port'),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

export const results = pgTable('results', {
  id: uuid('id').primaryKey().defaultRandom(),
  raceRunId: uuid('race_run_id').notNull().references(() => raceRuns.id, { onDelete: 'cascade' }),
  participantId: uuid('participant_id').notNull().references(() => participants.id, { onDelete: 'cascade' }),
  startTime: timestamp('start_time', { withTimezone: true }),
  finishTime: timestamp('finish_time', { withTimezone: true }),
  durationMs: bigint('duration_ms', { mode: 'number' }),
  gunDurationMs: bigint('gun_duration_ms', { mode: 'number' }),
  startCrossingId: uuid('start_crossing_id'),
  finishCrossingId: uuid('finish_crossing_id'),
  position: integer('position'),
  status: text('status').notNull().default('registered'),
  // 'registered'|'checked_in'|'started'|'finished'|'dnf'|'dns'|'dsq'
  statusNote: text('status_note'),
  manualOverride: boolean('manual_override').notNull().default(false),
  startTimeSource:  text('start_time_source'),
  startTimeTrigger: text('start_time_trigger'),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
}, (t) => [
  unique().on(t.raceRunId, t.participantId),
])

export const checkpointImports = pgTable('checkpoint_imports', {
  id: uuid('id').primaryKey().defaultRandom(),
  raceRunId: uuid('race_run_id').notNull().references(() => raceRuns.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow(),
  fileName: text('file_name'),
})

export const checkpointReadings = pgTable('checkpoint_readings', {
  id: uuid('id').primaryKey().defaultRandom(),
  importId: uuid('import_id').notNull().references(() => checkpointImports.id, { onDelete: 'cascade' }),
  epc: text('epc').notNull(),
  participantId: uuid('participant_id').references(() => participants.id, { onDelete: 'set null' }),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  rssiCdbm: integer('rssi_cdbm'),
})

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const checkpoints = pgTable('checkpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kmMarker: numeric('km_marker', { precision: 6, scale: 2 }),
  private: boolean('private').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

export const checkpointCategories = pgTable('checkpoint_categories', {
  checkpointId: uuid('checkpoint_id').notNull().references(() => checkpoints.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
}, (t) => [
  { primaryKey: [t.checkpointId, t.categoryId] },
])

export const checkpointObservations = pgTable('checkpoint_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  checkpointId: uuid('checkpoint_id').notNull().references(() => checkpoints.id, { onDelete: 'cascade' }),
  bibNumber: integer('bib_number').notNull(),
  participantId: uuid('participant_id').references(() => participants.id, { onDelete: 'set null' }),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

export const eventDocuments = pgTable('event_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(),           // 'acknowledge' | 'provide' | 'info'
  url: text('url'),
  requiredFor: text('required_for').notNull().default('all'),  // 'all' | 'minors'
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

export const checkins = pgTable('checkins', {
  id: uuid('id').primaryKey().defaultRandom(),
  participantId: uuid('participant_id').notNull().unique().references(() => participants.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
})

export const checkinDocuments = pgTable('checkin_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  checkinId: uuid('checkin_id').notNull().references(() => checkins.id, { onDelete: 'cascade' }),
  documentId: uuid('document_id').notNull().references(() => eventDocuments.id, { onDelete: 'cascade' }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedBy: text('completed_by'),    // 'participant' | 'admin'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
}, (t) => [
  unique().on(t.checkinId, t.documentId),
])

// ─── Relations ───────────────────────────────────────────────────────────────

export const eventsRelations = relations(events, ({ many }) => ({
  categories: many(categories),
  eventDocuments: many(eventDocuments),
  checkins: many(checkins),
}))

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  event: one(events, { fields: [categories.eventId], references: [events.id] }),
  participants: many(participants),
  raceRuns: many(raceRuns),
}))

export const participantsRelations = relations(participants, ({ one }) => ({
  category: one(categories, { fields: [participants.categoryId], references: [categories.id] }),
  event: one(events, { fields: [participants.eventId], references: [events.id] }),
  checkin: one(checkins, { fields: [participants.id], references: [checkins.participantId] }),
}))

export const raceRunsRelations = relations(raceRuns, ({ one, many }) => ({
  category: one(categories, { fields: [raceRuns.categoryId], references: [categories.id] }),
  results: many(results),
  gateCrossings: many(gateCrossings),
  gateEvents: many(gateEvents),
}))

export const resultsRelations = relations(results, ({ one }) => ({
  raceRun: one(raceRuns, { fields: [results.raceRunId], references: [raceRuns.id] }),
  participant: one(participants, { fields: [results.participantId], references: [participants.id] }),
}))

export const gateCrossingsRelations = relations(gateCrossings, ({ one }) => ({
  raceRun: one(raceRuns, { fields: [gateCrossings.raceRunId], references: [raceRuns.id] }),
  participant: one(participants, { fields: [gateCrossings.participantId], references: [participants.id] }),
}))

export const gateEventsRelations = relations(gateEvents, ({ one }) => ({
  raceRun: one(raceRuns, { fields: [gateEvents.raceRunId], references: [raceRuns.id] }),
}))

export const checkpointImportsRelations = relations(checkpointImports, ({ one, many }) => ({
  raceRun: one(raceRuns, { fields: [checkpointImports.raceRunId], references: [raceRuns.id] }),
  readings: many(checkpointReadings),
}))

export const checkpointReadingsRelations = relations(checkpointReadings, ({ one }) => ({
  import: one(checkpointImports, { fields: [checkpointReadings.importId], references: [checkpointImports.id] }),
  participant: one(participants, { fields: [checkpointReadings.participantId], references: [participants.id] }),
}))

export const checkpointsRelations = relations(checkpoints, ({ one, many }) => ({
  event: one(events, { fields: [checkpoints.eventId], references: [events.id] }),
  checkpointCategories: many(checkpointCategories),
  observations: many(checkpointObservations),
}))

export const checkpointObservationsRelations = relations(checkpointObservations, ({ one }) => ({
  checkpoint: one(checkpoints, { fields: [checkpointObservations.checkpointId], references: [checkpoints.id] }),
  participant: one(participants, { fields: [checkpointObservations.participantId], references: [participants.id] }),
}))

export const eventDocumentsRelations = relations(eventDocuments, ({ one }) => ({
  event: one(events, { fields: [eventDocuments.eventId], references: [events.id] }),
}))

export const checkinsRelations = relations(checkins, ({ one, many }) => ({
  participant: one(participants, { fields: [checkins.participantId], references: [participants.id] }),
  event: one(events, { fields: [checkins.eventId], references: [events.id] }),
  documents: many(checkinDocuments),
}))

export const checkinDocumentsRelations = relations(checkinDocuments, ({ one }) => ({
  checkin: one(checkins, { fields: [checkinDocuments.checkinId], references: [checkins.id] }),
  document: one(eventDocuments, { fields: [checkinDocuments.documentId], references: [eventDocuments.id] }),
}))
