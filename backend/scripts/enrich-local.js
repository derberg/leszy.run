#!/usr/bin/env node

/**
 * Local enrichment script — runs on Mac where Claude CLI is available.
 * Processes ALL events that have registration_url but no enriched_at.
 *
 * Usage: node backend/scripts/enrich-local.js [--batch N] [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chromium } from 'playwright'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kojoxazlnxncrpxmnxiq.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY env var')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const batchIdx = args.indexOf('--batch')
const BATCH_SIZE = batchIdx !== -1 ? parseInt(args[batchIdx + 1], 10) : 500

const VOIVODESHIPS = [
  'Dolnośląskie', 'Kujawsko-Pomorskie', 'Łódzkie', 'Lubelskie', 'Lubuskie',
  'Małopolskie', 'Mazowieckie', 'Opolskie', 'Podkarpackie', 'Podlaskie',
  'Pomorskie', 'Śląskie', 'Świętokrzyskie', 'Warmińsko-Mazurskie',
  'Wielkopolskie', 'Zachodniopomorskie',
]

const VALID_EVENT_TYPES = ['trail', 'nocny', 'ocr', 'nordic', 'ultra', 'charytatywny', 'uliczny']

function checkClaudeCli() {
  try {
    execSync('claude --version', { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function buildPrompt(event, pageText) {
  return `You are extracting structured data about a Polish running/walking race event from its official website.

Event name: ${event.name}
Event date: ${event.date}
Event location: ${event.location || 'unknown'}

Website content:
${pageText}

Extract the following information. Return ONLY valid JSON, no other text.
{
  "distances_km": [numbers, e.g. 5, 10, 21.1, 42.2] or null,
  "event_type": [array from: "trail", "nocny", "ocr", "nordic", "ultra", "charytatywny", "uliczny"] or null,
  "voivodeship": "one of 16 Polish voivodeships" or null,
  "price_from_pln": number (lowest entry fee in PLN) or null,
  "price_to_pln": number (highest entry fee in PLN) or null,
  "organizer": "organizer name" or null,
  "registration_deadline": "YYYY-MM-DD" or null,
  "description": "1-2 sentence summary of the event in Polish" or null
}

Rules:
- Only include distances that are actual race distances, not age limits or other numbers
- For półmaraton include 21.1, for maraton include 42.2
- Prices should be in PLN (złotych), not grosze
- If information is not found on the page, use null
- voivodeship must be one of: ${VOIVODESHIPS.join(', ')}`
}

function callClaude(prompt) {
  const tmpFile = join(tmpdir(), `llm-enrich-${Date.now()}.txt`)
  try {
    writeFileSync(tmpFile, prompt, 'utf-8')
    const result = execSync(
      `cat "${tmpFile}" | claude -p --model haiku --output-format text`,
      { encoding: 'utf-8', timeout: 60000, maxBuffer: 1024 * 1024 }
    )
    const match = result.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch (err) {
    console.error(`  Claude call failed:`, err.message?.slice(0, 100))
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
  return null
}

function validateAndMerge(event, extracted) {
  const updates = {}

  if (extracted.distances_km && Array.isArray(extracted.distances_km) && extracted.distances_km.length > 0) {
    const valid = extracted.distances_km.filter(d => typeof d === 'number' && d > 0 && d < 500)
    if (valid.length > 0 && (!event.distances_meters || event.distances_meters.length === 0)) {
      updates.distances = valid.map(d => `${d} km`)
      updates.distances_meters = valid.map(d => Math.round(d * 1000))
    }
  }

  if (extracted.event_type && Array.isArray(extracted.event_type)) {
    const valid = extracted.event_type.filter(t => VALID_EVENT_TYPES.includes(t))
    if (valid.length > 0 && (!event.event_type || event.event_type.length === 0)) {
      updates.event_type = valid
    }
  }

  if (extracted.voivodeship && VOIVODESHIPS.includes(extracted.voivodeship)) {
    if (!event.voivodeship) updates.voivodeship = extracted.voivodeship
  }

  if (typeof extracted.price_from_pln === 'number' && extracted.price_from_pln > 0) {
    if (!event.price_from) updates.price_from = Math.round(extracted.price_from_pln * 100)
  }
  if (typeof extracted.price_to_pln === 'number' && extracted.price_to_pln > 0) {
    if (!event.price_to) updates.price_to = Math.round(extracted.price_to_pln * 100)
  }

  if (extracted.organizer && typeof extracted.organizer === 'string') {
    if (!event.organizer) updates.organizer = extracted.organizer.slice(0, 200)
  }

  if (extracted.registration_deadline && /^\d{4}-\d{2}-\d{2}$/.test(extracted.registration_deadline)) {
    if (!event.registration_deadline) updates.registration_deadline = extracted.registration_deadline
  }

  if (extracted.description && typeof extracted.description === 'string') {
    if (!event.description) updates.description = extracted.description.slice(0, 2000)
  }

  return updates
}

async function fetchPageText(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
  } catch {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })
    } catch (err) {
      console.error(`  Failed to load ${url}:`, err.message?.slice(0, 80))
      return null
    }
  }
  try {
    const text = await page.evaluate(() => document.body.innerText)
    return text?.replace(/\s+/g, ' ').trim().slice(0, 5000) || null
  } catch {
    return null
  }
}

async function main() {
  console.log('=== Local Enrichment Script ===')
  console.log(`Batch size: ${BATCH_SIZE}, Dry run: ${dryRun}`)

  if (!checkClaudeCli()) {
    console.error('Claude CLI not available. Install with: npm install -g @anthropic-ai/claude-code')
    process.exit(1)
  }
  console.log('Claude CLI: OK')

  // Fetch events needing enrichment (have URL, no enriched_at)
  const { data: events, error } = await supabase
    .from('calendar_events')
    .select('id, name, date, location, registration_url, distances, distances_meters, event_type, voivodeship, price_from, price_to, organizer, registration_deadline, description')
    .is('enriched_at', null)
    .not('registration_url', 'is', null)
    .eq('status', 'active')
    .gte('date', new Date().toISOString().split('T')[0])
    .limit(BATCH_SIZE)

  if (error) { console.error('Supabase query failed:', error.message); process.exit(1) }
  if (!events?.length) { console.log('No events need enrichment.'); process.exit(0) }

  console.log(`Found ${events.length} events to enrich\n`)

  if (dryRun) {
    events.forEach(e => console.log(`  ${e.name} → ${e.registration_url}`))
    process.exit(0)
  }

  let enriched = 0
  let skipped = 0
  let failed = 0
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(15000)

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    console.log(`[${i + 1}/${events.length}] ${event.name}`)
    console.log(`  URL: ${event.registration_url}`)

    const pageText = await fetchPageText(page, event.registration_url)

    if (!pageText || pageText.length < 50) {
      console.log(`  Skipped (no content)`)
      await supabase.from('calendar_events').update({ enriched_at: new Date().toISOString() }).eq('id', event.id)
      skipped++
      continue
    }

    const prompt = buildPrompt(event, pageText)
    const extracted = callClaude(prompt)

    if (extracted) {
      const updates = validateAndMerge(event, extracted)
      const fieldCount = Object.keys(updates).length

      if (fieldCount > 0) {
        updates.enriched_at = new Date().toISOString()
        const { error: updateErr } = await supabase.from('calendar_events').update(updates).eq('id', event.id)
        if (!updateErr) {
          console.log(`  Enriched ${fieldCount} fields: ${Object.keys(updates).filter(k => k !== 'enriched_at').join(', ')}`)
          enriched++
        } else {
          console.error(`  Update failed:`, updateErr.message)
          failed++
        }
      } else {
        await supabase.from('calendar_events').update({ enriched_at: new Date().toISOString() }).eq('id', event.id)
        console.log(`  No new fields to fill`)
        skipped++
      }
    } else {
      await supabase.from('calendar_events').update({ enriched_at: new Date().toISOString() }).eq('id', event.id)
      console.log(`  Claude returned no data`)
      failed++
    }

    await new Promise(r => setTimeout(r, 2000))
  }

  await browser.close()

  console.log(`\n=== Done ===`)
  console.log(`Enriched: ${enriched}`)
  console.log(`Skipped (no content / no new fields): ${skipped}`)
  console.log(`Failed: ${failed}`)
  console.log(`Total processed: ${events.length}`)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
