// Deterministic "could this field possibly have come from this document?" checks.
//
// WHY
// An LLM asked to find a fee in a document that has none does not reliably
// answer null — it answers something. Measured in scraper_all on 2026-09-11:
// 15 rows carry price_from=0 / price_to=500, all enriched in April 2026, and 8
// of them were enriched from a consent form that contains no fee at all. The
// "0–500 zł" was invented whole, and it shipped to calendar_events where it sat
// for five months.
//
// The fix does not need a better model. If the source text contains no fee
// token and does not say the race is free, no fee can have been extracted from
// it, and the value is dropped regardless of how confident the extraction
// looked. Same for a deadline.
//
// These gates only ever REJECT. They never approve a value or supply one.

// "opłata startowa", "wpisowe", "50 zł", "koszt uczestnictwa", "PLN"
const FEE_TOKENS = /(op[lł]at|wpisow|koszt|cennik|\bz[lł]\b|\bzloty|\bz[lł]otych\b|\bPLN\b)/i

// A free race is a price of 0, not a missing price, and a regulamin that says
// so names no currency: "Udział w Mityngach jest bezpłatny" is the whole fee
// section. Without this the fee gate deleted the correct price_from=0 — it did
// so for zapisyonline:1128, whose 10706-character regulamin holds no fee token.
// Anchored to entry-fee wording so "bezpłatny parking" or "darmowa woda na
// trasie" does not open the gate. Mirrors _FREE_EVENT_RE in
// enricher/enricher/steps/regex_prepass.py.
const FREE_TOKENS = new RegExp(
  '(?:' +
  'udzia[lł]\\s+(?:w\\s+\\p{L}+\\s+)?(?:jest\\s+)?(?:darmow|bezp[lł]atn|nieodp[lł]atn)' +
  '|nie\\s+(?:ma|pobier\\p{L}*|wnosi\\s+si[eę])\\s+op[lł]at' +
  '|brak\\s+op[lł]at\\s+(?:start|wpisow)' +
  '|(?:op[lł]ata|wpisowe)\\s+(?:start\\p{L}+\\s+)?(?:wynosi\\s+)?0\\s*(?:z[lł]|pln)?\\s*(?:[.,]|$)' +
  '|wpisowe\\s+nie\\s+(?:obowi[aą]zuje|jest)' +
  '|wolny\\s+od\\s+op[lł]at' +
  '|bez\\s+op[lł]at\\p{L}*\\s+startow\\p{L}*' +
  ')',
  'iu'
)

// "zapisy do", "zgłoszenia przyjmowane do", "termin", "rejestracja do dnia"
const DEADLINE_TOKENS = /(termin|zapisy|zg[lł]oszeni|rejestracj|do\s+dnia|zamkni[eę]cie\s+list)/i

/** @returns {boolean} true when the text could plausibly state an entry fee */
export function hasFeeEvidence(text) {
  return FEE_TOKENS.test(String(text || ''))
}

/** @returns {boolean} true when the text says the race costs nothing */
export function hasFreeEvidence(text) {
  return FREE_TOKENS.test(String(text || ''))
}

/** @returns {boolean} true when the text could plausibly state a registration deadline */
export function hasDeadlineEvidence(text) {
  return DEADLINE_TOKENS.test(String(text || ''))
}

/**
 * Strip extracted values the source document cannot support.
 *
 * @param {object} extracted  the LLM's parsed JSON (mutated in place)
 * @param {string} text       the document the extraction came from
 * @returns {string[]}        names of the fields that were dropped
 */
export function dropUnsupportedFields(extracted, text) {
  const dropped = []
  if (!extracted || typeof extracted !== 'object') return dropped

  // A document that only says the race is free supports one price, 0. Any other
  // number still has no evidence behind it, so it is dropped as before.
  const feeEvidence = hasFeeEvidence(text)
  const freeEvidence = !feeEvidence && hasFreeEvidence(text)
  if (!feeEvidence) {
    for (const f of ['price_from', 'price_to']) {
      if (extracted[f] === undefined || extracted[f] === null) continue
      if (freeEvidence && Number(extracted[f]) === 0) continue
      delete extracted[f]
      dropped.push(f)
    }
  }
  if (!hasDeadlineEvidence(text)) {
    if (extracted.registration_deadline !== undefined && extracted.registration_deadline !== null) {
      delete extracted.registration_deadline
      dropped.push('registration_deadline')
    }
  }
  return dropped
}
