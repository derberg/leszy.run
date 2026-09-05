import { execSync } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Second opinion on a URL that a web search produced. Only search-derived
// candidates come here: a scraper column is the organizer's own declaration,
// and resolveDostartuRegulamin derives its URL deterministically and fetches it.
//
// The verifier runs as its own `claude -p` process with WebFetch and WITHOUT
// WebSearch. It can only fetch and judge the URLs handed to it, so it cannot
// answer with a URL of its own, and it holds no record of why the first agent
// chose the candidate. Granting WebSearch here would collapse the two roles
// back into one agent grading its own work, which is the failure this module
// exists to break.
const ALLOWED_TOOLS = 'WebFetch'

// Verdict names match parse_verdict() in enricher/enricher/steps/audit_verdict.py
// so both pipelines report the same three outcomes.
const ALLOWED_VERDICTS = new Set(['match', 'mismatch', 'uncertain'])

export function buildVerifyPrompt(event, urls) {
  const year = (event.date || '').slice(0, 4)
  const fields = Object.keys(urls)
  const urlBlock = fields.map(f => `  ${f}: ${urls[f]}`).join('\n')
  const shape = fields
    .map(f => `  "${f}": { "verdict": "match" | "mismatch" | "uncertain", "confidence": 0.0-1.0, "reasoning": "one short sentence citing evidence from the page" }`)
    .join(',\n')

  return `You are checking whether each URL below really belongs to one specific Polish running event. Another agent proposed these URLs. Your job is to confirm or reject them, not to find better ones.

EVENT
  name: ${event.name}
  date: ${event.date}
  year: ${year || '(unknown)'}
  city: ${event.location || '(unknown)'}
  voivodeship: ${event.voivodeship || '(unknown)'}
  known distances: ${event.distances || '(unknown)'}

URLS TO CHECK
${urlBlock}

METHOD
  Fetch every URL above. For a PDF, read its text. Then judge each one on its own.

  Return "match" only when all three of these hold on the fetched page:
    1. The event name appears, allowing for Polish letter folding (a for ą, c for ć,
       e for ę, l for ł, n for ń, o for ó, s for ś, z for ź and ż) and for at least
       80% token overlap with the name above.
    2. The year ${year || 'of the event'} appears, or the page states the full event date.
    3. The city appears, or the page names a location within a few kilometres of it.

  Return "mismatch" when any of these is true:
    - The page describes a previous or later edition of the same race. A page for the
      same name in a different year is a mismatch, not a match. This is the single
      most common error, so check the year on every page before answering.
    - The page describes a different race, or is a news article.
    - The page is an aggregator listing rather than the event's own registration or
      rules document (maratonypolskie.pl, kalendarzbiegowy.pl, zawodybiegowe.pl,
      zapisysportowe.pl and similar).
    - The page does not load, returns an error, or shows a generic login or search
      screen with no event content.

  Return "uncertain" only when the page loads and you genuinely cannot tell.

RULES
  Do not search the web. Judge only the URLs listed above.
  Do not propose a replacement URL. A rejection is a complete answer.

OUTPUT - return ONLY valid JSON, no other text:
{
${shape}
}`
}

export function parseVerdicts(raw, fields) {
  const out = {}
  let parsed = null
  const text = typeof raw === 'string' ? raw : ''
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '')
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      parsed = JSON.parse(match[0])
    } catch {
      parsed = null
    }
  }

  for (const field of fields) {
    const entry = parsed?.[field]
    const verdict = entry?.verdict
    // A field the verifier skipped, or answered with a name we do not recognise,
    // is not evidence of a match. Dropping the candidate keeps the column empty,
    // which a later run can retry. Keeping it would write the exact unchecked
    // URL this module exists to stop.
    if (!ALLOWED_VERDICTS.has(verdict)) {
      out[field] = {
        verdict: 'mismatch',
        confidence: 0,
        reasoning: parsed === null
          ? 'Verifier returned no parseable JSON.'
          : `Verifier returned no usable verdict for ${field}.`,
      }
      continue
    }
    const confidence = typeof entry.confidence === 'number'
      ? Math.min(1, Math.max(0, entry.confidence))
      : 0
    out[field] = {
      verdict,
      confidence,
      reasoning: typeof entry.reasoning === 'string' ? entry.reasoning : '',
    }
  }
  return out
}

function runClaudeVerify(prompt) {
  const promptFile = join(tmpdir(), `verify-prompt-${Date.now()}.txt`)
  try {
    writeFileSync(promptFile, prompt, 'utf-8')
    // Same isolation as callClaude in run-enrich-search.js: without
    // --setting-sources "" and --strict-mcp-config, a Stop hook from the
    // interactive setup replaces the final message, so response.result carries
    // the hook's text instead of the verdict JSON and every field is rejected.
    const raw = execSync(
      `cat "${promptFile}" | claude -p --setting-sources "" --strict-mcp-config --allowedTools "${ALLOWED_TOOLS}" --model sonnet --output-format json`,
      { encoding: 'utf-8', timeout: 300000, maxBuffer: 2 * 1024 * 1024, cwd: tmpdir() }
    )
    const response = JSON.parse(raw)
    return {
      text: response.result || '',
      costUsd: response.total_cost_usd || 0,
      inputTokens: (response.usage?.input_tokens || 0) + (response.usage?.cache_read_input_tokens || 0),
      outputTokens: response.usage?.output_tokens || 0,
    }
  } finally {
    try { unlinkSync(promptFile) } catch {}
  }
}

/**
 * Confirm that each search-found URL belongs to this event.
 *
 * @param {object} event   scraper_all row, needs name/date/location at minimum
 * @param {object} urls    {field: url} produced by the search step only
 * @param {object} [deps]  {runClaude} injection point for tests
 * @returns {Promise<{verdicts: object, kept: object, dropped: Array, costUsd: number,
 *                    inputTokens: number, outputTokens: number}>}
 *          `kept` holds only the fields whose verdict is match, so a caller can
 *          assign it straight into its updates.
 */
export async function verifySearchUrls(event, urls, deps = {}) {
  const runClaude = deps.runClaude || runClaudeVerify
  const fields = Object.keys(urls || {}).filter(f => urls[f])
  const empty = { verdicts: {}, kept: {}, dropped: [], costUsd: 0, inputTokens: 0, outputTokens: 0 }
  if (fields.length === 0) return empty

  const scoped = {}
  for (const f of fields) scoped[f] = urls[f]

  let result
  try {
    result = await runClaude(buildVerifyPrompt(event, scoped))
  } catch (err) {
    // A crashed or timed-out verifier confirms nothing, so every candidate drops.
    return {
      verdicts: {},
      kept: {},
      dropped: fields.map(f => ({
        field: f, url: scoped[f], verdict: 'mismatch', confidence: 0,
        reasoning: `Verifier failed: ${String(err?.message || err).slice(0, 200)}`,
      })),
      costUsd: 0, inputTokens: 0, outputTokens: 0,
    }
  }

  const verdicts = parseVerdicts(result?.text, fields)
  const kept = {}
  const dropped = []
  for (const f of fields) {
    const v = verdicts[f]
    if (v.verdict === 'match') {
      kept[f] = scoped[f]
    } else {
      dropped.push({ field: f, url: scoped[f], ...v })
    }
  }

  return {
    verdicts,
    kept,
    dropped,
    costUsd: result?.costUsd || 0,
    inputTokens: result?.inputTokens || 0,
    outputTokens: result?.outputTokens || 0,
  }
}
