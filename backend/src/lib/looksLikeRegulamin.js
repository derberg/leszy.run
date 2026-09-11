// Does this document's TEXT actually read like a race regulamin?
//
// WHY A STRUCTURAL TEST AND NOT A KEYWORD
// The obvious check — "does it contain the word regulamin" — does not work. A
// parental consent form says "oświadczam, że zapoznałem/am się z treścią
// REGULAMINU Biegu…", so it passes a keyword test while containing no fee, no
// deadline, no distances. That is exactly the document that reached the LLM for
// the Oława races and produced a fabricated 0–500 zł price range.
//
// What actually separates them is STRUCTURE. A regulamin is a multi-section
// document (postanowienia, klasyfikacja, nagrody, zgłoszenia, opłata, biuro
// zawodów…). A consent form is one short page of first-person declarations and
// GDPR boilerplate, repeated once per copy.
//
// This gate runs where the text already exists — the enrichment step — so it
// costs no extra download and needs no PDF parser of its own.

// Sections/《furniture》a real regulamin has. Counted as DISTINCT hits, so a
// consent form repeating one phrase ten times does not accumulate a score.
const SECTIONS = [
  /postanowienia/i,
  /klasyfikacj/i,
  /nagrod/i,
  /zg[lł]oszeni/i,
  /(op[lł]at[ay]|wpisow)/i,
  /biuro\s+zawod/i,
  /limit\s+(czasu|zawodnik|uczestnik|miejsc)/i,
  /(dystans|trasa|trasy)/i,
  /organizator/i,
  /(uczestnictw|warunki\s+udzia[lł])/i,
  /(start\b|meta\b)/i,
  /(kategori|generaln)/i,
]

// First-person declaration furniture — the signature of a consent form.
const DECLARATIONS = [
  /o[sś]wiadczam/i,
  /wyra[zż]am\s+zgod/i,
  /podpis\s+(rodzica|opiekuna|uczestnika|zawodnika)/i,
  /imi[eę]\s+i\s+nazwisko\s+(osoby\s+niepe[lł]noletniej|rodzica|opiekuna)/i,
  /zgod[aę]\s+na\s+udzia[lł]/i,
  /jako\s+rodzic/i,
]

// Below this much extractable text we cannot judge the document at all. That is
// NOT the same as judging it wrong, and the difference matters: measured over
// one live regulamin per source (2026-09-11, 28 documents), two legitimate ones
// yield almost no text — foxter publishes a three-line hub linking a regulamin
// per distance, and zapisyonline serves scans with no text layer. Rejecting
// those would null good data, so they come back 'unknown' and the caller leaves
// them alone.
const MIN_TEXT_CHARS = 400

/**
 * @param {string} text  extracted document text
 * @returns {{verdict: 'regulamin'|'not-regulamin'|'unknown', sections: number, declarations: number, reason: string|null}}
 */
export function looksLikeRegulamin(text) {
  const t = String(text || '')
  if (t.replace(/\s+/g, '').length < MIN_TEXT_CHARS) {
    return {
      verdict: 'unknown',
      sections: 0,
      declarations: 0,
      reason: 'too little extractable text to judge (scan, or a link-hub PDF)',
    }
  }

  const sections = SECTIONS.filter((re) => re.test(t)).length
  const declarations = DECLARATIONS.filter((re) => re.test(t)).length

  // A regulamin covers many sections. Below this it is some other document —
  // a consent form, a map legend, a GDPR clause, a results list.
  if (sections < 5) {
    return {
      verdict: 'not-regulamin',
      sections,
      declarations,
      reason: `only ${sections} regulamin sections present (need 5)`,
    }
  }

  // A long consent form can brush 5 sections by quoting the event's details, so
  // heavy first-person declaration furniture still disqualifies it unless the
  // document is unambiguously a full regulamin.
  if (declarations >= 2 && sections < 8) {
    return {
      verdict: 'not-regulamin',
      sections,
      declarations,
      reason: `reads as a declaration/consent form (${declarations} declaration markers, ${sections} sections)`,
    }
  }

  return { verdict: 'regulamin', sections, declarations, reason: null }
}
