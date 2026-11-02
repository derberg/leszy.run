// Turns a plain-text agreement (paragraphs separated by a blank line) into
// sections a page can lay out: "§N. Title" opens a section, "1." is a
// numbered point, "a)" a lettered sub-point. An unmarked paragraph that
// follows a point continues that point, so it is indented with it; one before
// the first point of a section is the section's lead-in.

const HEADING = /^(§\s*\d+)\.\s+(.+)$/
const POINT = /^(\d+)\.\s+([\s\S]+)$/
const SUB = /^([a-z])\)\s+([\s\S]+)$/

/**
 * @param {string} body
 * @returns {{ preamble: Block[], sections: { number: string, title: string, blocks: Block[] }[] }}
 * @typedef {{ kind: 'p' | 'point' | 'sub' | 'cont', marker?: string, text: string }} Block
 */
export function agreementSections(body) {
  const paragraphs = (body || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const preamble = []
  const sections = []
  let blocks = preamble
  let last = null
  for (const p of paragraphs) {
    const heading = p.match(HEADING)
    if (heading) {
      const section = { number: heading[1].replace(/\s+/g, ''), title: heading[2], blocks: [] }
      sections.push(section)
      blocks = section.blocks
      last = null
      continue
    }
    const point = p.match(POINT)
    const sub = !point && p.match(SUB)
    let block
    if (point) block = { kind: 'point', marker: `${point[1]}.`, text: point[2] }
    else if (sub) block = { kind: 'sub', marker: `${sub[1]})`, text: sub[2] }
    else block = { kind: last ? 'cont' : 'p', text: p }
    blocks.push(block)
    if (block.kind !== 'p') last = block
  }
  return { preamble, sections }
}

// Splits text around "[DO UZUPEŁNIENIA: …]" / "[DO WERYFIKACJI: …]" drafting
// notes, so the page can set them apart from the agreement's own wording.
export function draftNoteSegments(text) {
  return text
    .split(/(\[DO (?:UZUPEŁNIENIA|WERYFIKACJI)[^\]]*\])/)
    .filter(Boolean)
    .map((t) => ({ note: /^\[DO (?:UZUPEŁNIENIA|WERYFIKACJI)/.test(t), text: t }))
}
