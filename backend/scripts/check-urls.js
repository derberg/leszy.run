#!/usr/bin/env node

/**
 * Checks all calendar event URLs for broken links (404, timeouts, errors).
 * Usage: SUPABASE_SERVICE_ROLE_KEY=... node backend/scripts/check-urls.js
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kojoxazlnxncrpxmnxiq.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function checkUrl(url) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'leszy.run/1.0 link-checker' },
      redirect: 'follow',
    })
    clearTimeout(timeout)
    return { status: res.status, ok: res.ok }
  } catch (err) {
    // Some servers reject HEAD, try GET
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'leszy.run/1.0 link-checker' },
        redirect: 'follow',
      })
      clearTimeout(timeout)
      // Read a bit to avoid hanging
      await res.text().then(t => t.slice(0, 100)).catch(() => {})
      return { status: res.status, ok: res.ok }
    } catch (err2) {
      return { status: 0, ok: false, error: err2.cause?.code || err2.message?.slice(0, 60) }
    }
  }
}

async function main() {
  const { data: events, error } = await supabase
    .from('calendar_events')
    .select('id, name, registration_url, date')
    .not('registration_url', 'is', null)
    .eq('status', 'active')
    .gte('date', new Date().toISOString().split('T')[0])
    .order('date')

  if (error) { console.error('Query failed:', error.message); process.exit(1) }

  console.log(`Checking ${events.length} URLs...\n`)

  const broken = []
  const CONCURRENCY = 10

  for (let i = 0; i < events.length; i += CONCURRENCY) {
    const batch = events.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map(async (ev) => {
      const result = await checkUrl(ev.registration_url)
      if (!result.ok) {
        broken.push({ id: ev.id, name: ev.name, date: ev.date, url: ev.registration_url, status: result.status, error: result.error })
        process.stdout.write('X')
      } else {
        process.stdout.write('.')
      }
      return result
    }))

    if ((i + CONCURRENCY) % 100 === 0) {
      process.stdout.write(` ${i + CONCURRENCY}/${events.length}\n`)
    }
  }

  console.log(`\n\n=== Results ===`)
  console.log(`Total checked: ${events.length}`)
  console.log(`Broken: ${broken.length}\n`)

  if (broken.length > 0) {
    console.log('Broken URLs:')
    for (const b of broken) {
      console.log(`  [${b.status}${b.error ? ' ' + b.error : ''}] ${b.name} (${b.date})`)
      console.log(`    ${b.url}`)
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
