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
//
// Each entry carries its English wording too. Some organisers publish the
// regulamin in translation and pickRegulaminUrl lands on that copy: Silesia 5K
// RUN 2026 pointed at /en/regulamin-silesia-5k-run-2026/, a complete document
// with tiered entry fees and an entry deadline, which the Polish-only stems
// scored 1 of 12. One section is one hit whichever language states it.
const SECTIONS = [
  /(postanowienia|(final|general)\s+provisions)/i,
  /(klasyfikacj|classification)/i,
  /(nagrod|prizes?\b|awards?\b)/i,
  /(zg[lł]oszeni|registration)/i,
  /(op[lł]at[ay]|wpisow|(entry|registration|start(ing)?)\s+fee)/i,
  /(biuro\s+zawod|(race|competition)\s+office)/i,
  /(limit\s+(czasu|zawodnik|uczestnik|miejsc)|(time|participant)\s+limit|limit\s+of\s+(spots|places|participants))/i,
  /(dystans|trasa|trasy|\bdistance|\broute\b|\bcourse\b)/i,
  /(organizator|organi[sz]er)/i,
  /(uczestnictw|warunki\s+udzia[lł]|participation)/i,
  /(start\b|meta\b|finish\b)/i,
  /(kategori|generaln|categor(y|ies)\b)/i,
]

// First-person declaration furniture — the signature of a consent form, in
// either language. Kept first-person on purpose: a real regulamin often ends
// with a third-person GDPR clause ("the participant declares that…"), and that
// must not count against it.
const DECLARATIONS = [
  /o[sś]wiadczam/i,
  /wyra[zż]am\s+zgod/i,
  /podpis\s+(rodzica|opiekuna|uczestnika|zawodnika)/i,
  /imi[eę]\s+i\s+nazwisko\s+(osoby\s+niepe[lł]noletniej|rodzica|opiekuna)/i,
  /zgod[aę]\s+na\s+udzia[lł]/i,
  /jako\s+rodzic/i,
  /\bi\s+(hereby\s+)?declare\b/i,
  /\bi\s+(hereby\s+)?(consent|agree)\s+to\b/i,
  /signature\s+of\s+the\s+(parent|legal\s+guardian|participant|competitor)/i,
  /name\s+and\s+surname\s+of\s+the\s+(minor|child|parent|legal\s+guardian)/i,
  /\bas\s+a\s+(parent|legal\s+guardian)\b/i,
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
