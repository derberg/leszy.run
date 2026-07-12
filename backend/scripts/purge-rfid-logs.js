import postgres from 'postgres'

// Purge gate_events and gate_crossings for races that finished > 90 days ago.
// Only touches rows tied to race_runs with status 'finished' or 'cancelled'
// where finished_at is older than 90 days. The aggregated results table is
// never touched — it serves as the durable archive.
//
// Usage: node --env-file=../.env scripts/purge-rfid-logs.js

const sql = postgres(process.env.DATABASE_URL || 'postgres://leszyrun:leszyrun@localhost:5432/leszyrun')

async function purgeRfidLogs() {
  const geResult = await sql`
    delete from gate_events
    where race_run_id in (
      select id from race_runs
      where status in ('finished', 'cancelled')
        and finished_at < now() - interval '90 days'
    )
  `
  const gcResult = await sql`
    delete from gate_crossings
    where race_run_id in (
      select id from race_runs
      where status in ('finished', 'cancelled')
        and finished_at < now() - interval '90 days'
    )
  `

  console.log(
    `[purge-rfid-logs] deleted gate_events=${geResult.count}, gate_crossings=${gcResult.count}`
  )
}

purgeRfidLogs()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[purge-rfid-logs] error:', err)
    process.exit(1)
  })
