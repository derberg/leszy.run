import { supabase } from '../lib/supabaseClient.js'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chromium } from 'playwright'

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
    if (match) {
      return JSON.parse(match[0])
    }
  } catch (err) {
    console.error(`[enricher] Claude call failed:`, err.message?.slice(0, 100))
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
  return null
}

function validateAndMerge(event, extracted) {
  const updates = {}

  // Distances
  if (extracted.distances_km && Array.isArray(extracted.distances_km) && extracted.distances_km.length > 0) {
    const valid = extracted.distances_km.filter(d => typeof d === 'number' && d > 0 && d < 500)
    if (valid.length > 0 && (!event.distances_meters || event.distances_meters.length === 0)) {
      updates.distances = valid.map(d => `${d} km`)
      updates.distances_meters = valid.map(d => Math.round(d * 1000))
    }
  }

  // Event type
  if (extracted.event_type && Array.isArray(extracted.event_type)) {
    const valid = extracted.event_type.filter(t => VALID_EVENT_TYPES.includes(t))
    if (valid.length > 0 && (!event.event_type || event.event_type.length === 0)) {
      updates.event_type = valid
    }
  }

  // Voivodeship
  if (extracted.voivodeship && VOIVODESHIPS.includes(extracted.voivodeship)) {
    if (!event.voivodeship) {
      updates.voivodeship = extracted.voivodeship
    }
  }

  // Prices (convert PLN to grosze)
  if (typeof extracted.price_from_pln === 'number' && extracted.price_from_pln > 0) {
    if (!event.price_from) {
      updates.price_from = Math.round(extracted.price_from_pln * 100)
    }
  }
  if (typeof extracted.price_to_pln === 'number' && extracted.price_to_pln > 0) {
    if (!event.price_to) {
      updates.price_to = Math.round(extracted.price_to_pln * 100)
    }
  }

  // Organizer
  if (extracted.organizer && typeof extracted.organizer === 'string') {
    if (!event.organizer) {
      updates.organizer = extracted.organizer.slice(0, 200)
    }
  }

  // Registration deadline
  if (extracted.registration_deadline && /^\d{4}-\d{2}-\d{2}$/.test(extracted.registration_deadline)) {
    if (!event.registration_deadline) {
      updates.registration_deadline = extracted.registration_deadline
    }
  }

  // Description (only when NULL)
  if (extracted.description && typeof extracted.description === 'string') {
    if (!event.description) {
      updates.description = extracted.description.slice(0, 2000)
    }
  }

  return updates
}

async function fetchPageText(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
  } catch {
    // Fallback to domcontentloaded on timeout
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })
    } catch (err) {
      console.error(`[enricher] Failed to load ${url}:`, err.message?.slice(0, 80))
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

async function enrichEvents() {
  if (!supabase) {
    console.log('[enricher] Supabase not configured, skipping')
    return { processed: 0, enriched: 0 }
  }

  // Preflight: check Claude CLI
  if (!checkClaudeCli()) {
    console.log('[enricher] Claude CLI not available, skipping enrichment')
    return { processed: 0, enriched: 0 }
  }

  const { data: events } = await supabase
    .from('calendar_events')
    .select('id, name, date, location, registration_url, distances, distances_meters, event_type, voivodeship, price_from, price_to, organizer, registration_deadline, description')
    .is('enriched_at', null)
    .not('registration_url', 'is', null)
    .eq('status', 'active')
    .gte('date', new Date().toISOString().split('T')[0])
    .limit(parseInt(process.env.LLM_BATCH_SIZE || '50', 10))

  if (!events?.length) {
    console.log('[enricher] No events need enrichment')
    return { processed: 0, enriched: 0 }
  }

  console.log(`[enricher] Processing ${events.length} events...`)
  let enriched = 0
  let browser

  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    page.setDefaultTimeout(15000)

    for (const event of events) {
      console.log(`[enricher] ${event.name} → ${event.registration_url}`)

      // Fetch page content
      const pageText = await fetchPageText(page, event.registration_url)

      if (!pageText || pageText.length < 50) {
        console.log(`[enricher]   Skipped (no content)`)
        // Still mark as enriched to avoid retrying pages that don't load
        await supabase
          .from('calendar_events')
          .update({ enriched_at: new Date().toISOString() })
          .eq('id', event.id)
        continue
      }

      // Call Claude
      const prompt = buildPrompt(event, pageText)
      const extracted = callClaude(prompt)

      if (extracted) {
        const updates = validateAndMerge(event, extracted)
        const fieldCount = Object.keys(updates).length

        if (fieldCount > 0) {
          updates.enriched_at = new Date().toISOString()
          const { error } = await supabase
            .from('calendar_events')
            .update(updates)
            .eq('id', event.id)

          if (!error) {
            console.log(`[enricher]   Enriched ${fieldCount} fields: ${Object.keys(updates).filter(k => k !== 'enriched_at').join(', ')}`)
            enriched++
          } else {
            console.error(`[enricher]   Update failed:`, error.message)
          }
        } else {
          // No new fields but mark as enriched
          await supabase
            .from('calendar_events')
            .update({ enriched_at: new Date().toISOString() })
            .eq('id', event.id)
          console.log(`[enricher]   No new fields to fill`)
        }
      } else {
        // Claude returned nothing — still mark enriched
        await supabase
          .from('calendar_events')
          .update({ enriched_at: new Date().toISOString() })
          .eq('id', event.id)
        console.log(`[enricher]   Claude returned no data`)
      }

      // Delay between Claude CLI calls
      await new Promise(r => setTimeout(r, 2000))
    }
  } catch (err) {
    console.error('[enricher] Browser error:', err.message)
  } finally {
    if (browser) await browser.close()
  }

  console.log(`[enricher] Enriched ${enriched}/${events.length} events`)
  return { processed: events.length, enriched }
}

export { enrichEvents }
