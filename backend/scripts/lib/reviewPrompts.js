// Prompts for the pre-publish review agents.
//
// They are kept apart from the orchestrator because they are the part a person
// will want to read and adjust. The method they describe is the one that found
// the defects behind PR #104 to #118: take one event that published incomplete,
// follow the field down the four layers until one of them is where it stopped,
// then measure how many other rows stopped at the same place.

const LADDER = `
The field you are investigating passes through four layers. Walk them in order
and find the first one where it is absent or wrong.

  1. the projected calendar_events row   what run-publish would write
  2. scraper_all                          the merged, enriched record
  3. scraper_<source>                     what the scraper actually captured
  4. the live source page                 what the organizer actually published

Reading the result:

  present at 3, absent at 2   the merge dropped it        backend/src/scrapers/index.js
  absent at 3, present at 4   the scraper failed to read it  backend/src/scrapers/sources/<source>.js
  absent at 3 and at 4        nobody published it. This is NOT a defect.
  present at 2, wrong at 1    the publish step, or an enricher that wrote a wrong value
  present everywhere, wrong   an enricher overwrote a good value with a bad one
`

const HOUSE_RULES = `
Facts about this codebase you must not get wrong:

- Plain JavaScript. No TypeScript, ever. Tests use node:test and live in backend/test/.
- A 200 OK does not prove a URL is correct. Follow redirects with curl -sIL and
  confirm the page carries the event name, the race id or the date.
- regulamin means the rules document. Polish timing sites publish an
  oswiadczenie (consent form), a klauzula RODO and a course map on the same
  page. backend/src/lib/pickRegulaminUrl.js decides which link is the regulamin.
- A regulamin may be a PDF, a .docx, a plain HTML page, or a Google Drive folder.
- price_from 0 means the race is free. It is a value, not a missing value.
- An admin can lock a field as empty. A locked field is decided, not missing.
`

export function diagnosePrompt({ candidate, scraperAllRow, rawRow, existingRow, sourceFile }) {
  return `You are investigating ONE running event that is about to publish to a public
race calendar without enough data, and your job is to find out which piece of
code is responsible.

Work in the repository at the current working directory. It is read-only for
you: do not edit any file, do not run git, and do not write to any database.
You have no database credentials and do not need any. Every row you need is
below.

## The event

name:     ${candidate.name}
date:     ${candidate.date}
source:   ${candidate.source} (source_id ${candidate.source_id})
missing:  ${candidate.missing_required.join(', ')}

## Layer 1. The row run-publish would write

${JSON.stringify(candidate.projected, null, 2)}

## Layer 2. The scraper_all row

${scraperAllRow ? JSON.stringify(scraperAllRow, null, 2) : 'NOT FOUND in scraper_all'}

## Layer 3. The raw scraper_${candidate.source} row

${rawRow ? JSON.stringify(rawRow, null, 2) : `NOT FOUND in scraper_${candidate.source}`}

## The existing calendar_events row, if any

${existingRow ? JSON.stringify(existingRow, null, 2) : 'none, this event would be created'}

## Method
${LADDER}
The scraper for this source is ${sourceFile}. The merge and the publish step are
both in backend/src/scrapers/index.js. The Python enricher is under enricher/.

Fetch the live source page and read it. Use curl, and pdftotext or textutil for
documents. Confirm with your own eyes whether the organizer published the field
at all, because that answer decides whether there is a defect to fix.
${HOUSE_RULES}
## Answer

Answer for EVERY field in the missing list above, separately. They usually have
different causes: one may be a scraper bug while the next was simply never
published. An event that is missing four fields needs four entries.

Reply with one JSON object and nothing else.

{
  "fields": [
    {
      "field": "voivodeship",
      "verdict": "code-defect" | "absent-at-source" | "needs-human",
      "summary": "one sentence naming what went wrong for THIS field",
      "defect": {
        "layer": "scraper" | "merge" | "enricher" | "publish",
        "file": "repo-relative path of the file to change",
        "symbol": "the function to change",
        "signature": "short phrase naming the defect, e.g. detail parser accepts only .pdf",
        "explanation": "what the code does and what it should do",
        "proposed_fix": "the change you would make"
      },
      "evidence": [
        {"layer": "scraper_all", "observation": "voivodeship is null"},
        {"layer": "source page", "observation": "the city is spelled Zegiesto Zdroj, which geocodes to nothing"}
      ],
      "blast_radius": {
        "table": "scraper_all",
        "filters": [
          {"column": "source", "op": "eq", "value": "${candidate.source}"},
          {"column": "voivodeship", "op": "is", "value": null}
        ],
        "future_only": true
      },
      "confidence": 0.0
    }
  ]
}

Rules for the answer:

- One entry per missing field. Do not merge two fields into one entry, and do
  not answer for a field that is not in the missing list.
- "absent-at-source" is a correct and useful verdict, and it is recorded so that
  no later run pays to ask the same question again. Use it only when you fetched
  the page and saw for yourself that the organizer published nothing. Set
  "defect" to null.
- "needs-human" when you cannot reach the source, or the cause is a judgement
  call about policy rather than a bug.
- "blast_radius" describes the rows that share this defect, so that a fix can be
  measured AND so that the rows can be repaired after it merges. An enricher fix
  is only propagated to the rows its radius names, so a radius that is missing
  or wrong means the fix reaches nothing. Allowed ops: eq, neq, is, gt, gte, lt,
  lte, ilike. Allowed tables: scraper_all, calendar_events, scraper_<source>.
- Do not guess. If you did not verify a claim, do not make it.`
}

export function fixPrompt({ group, blastRadius, branch }) {
  const findings = group.findings
    .map(
      (f, i) => `### Finding ${i + 1}: ${f.event.name} (${f.event.date}, ${f.event.source}:${f.event.source_id})
field: ${f.field}
${f.defect?.explanation || ''}

proposed fix: ${f.defect?.proposed_fix || ''}

evidence:
${(f.evidence || []).map((e) => `  - ${e.layer}: ${e.observation}`).join('\n')}`
    )
    .join('\n\n')

  return `You are fixing one defect in a race calendar scraping pipeline. ${group.findings.length} event(s)
published incomplete because of it, and it lives in ${group.file}.

You are in a git worktree on branch ${branch}. Work here and nowhere else.

## The defect

layer: ${group.layer}
file:  ${group.file}
${blastRadius != null ? `rows affected: ${blastRadius}` : 'rows affected: not measured'}

${findings}

## What to do

1. Read ${group.file} and confirm the diagnosis yourself. The findings above
   come from agents that could not edit code. If they are wrong, say so in your
   answer and change nothing.
2. Write a test in backend/test/ that fails because of this defect. Run it and
   see it fail. A fix without a failing test first is not accepted.
3. Make the smallest change that fixes the defect, and keep the style of the
   surrounding code.
4. Run: npm test --workspace=backend
   Every test must pass, not only yours.
5. Commit. Then: git push -u origin ${branch} && gh pr create --fill

## Limits

You may only change files under: backend/src/scrapers/, backend/src/lib/,
backend/scripts/, backend/test/, enricher/. A pull request that touches anything
else is rejected automatically and your work is discarded. Do not edit CLAUDE.md,
migrations, or the frontend.

Never run INSERT, UPDATE, DELETE or TRUNCATE against any database. Data is
corrected by re-running the pipeline with fixed code, never by hand.

Do not add a Co-Authored-By trailer to the commit.
${HOUSE_RULES}
## How to write the commit message and the pull request body

Say what was wrong, what the code did, and what it does now. Name the event and
the measurement that proves it: "45 zapisyonline rows have no regulamin" is the
sentence that matters. No em-dashes. Short sentences. No marketing words.

## Answer

Finish with one JSON object and nothing else:

{
  "status": "fixed" | "no-change-needed" | "failed",
  "pr_number": 123,
  "branch": "${branch}",
  "test_file": "backend/test/x.test.js",
  "summary": "one sentence",
  "measurement": "what you counted before and after",
  "reason_if_no_change": "..."
}`
}

export function reviewPrompt({ group, diff, prNumber }) {
  const claims = group.findings
    .map((f) => `- ${f.event.name}: ${f.summary}`)
    .join('\n')

  return `Review a pull request that an automated agent wrote and that will be merged
without a person reading it unless you object. You are the only check.

You did not write this change and you have not seen the reasoning behind it.
Judge the diff.

## What the change is supposed to fix

file:  ${group.file}
layer: ${group.layer}

${claims}

## The diff of pull request #${prNumber}

\`\`\`diff
${diff}
\`\`\`

## What to check

1. Does the change actually fix the described defect, or only its symptom for
   one event?
2. Does it break another case? A scraper filter that drops cycling events can
   also drop a running event whose name contains a cycling word. Look for the
   case the author did not consider.
3. Is there a test, and would it fail without the fix?
4. Does it touch anything beyond backend/src/scrapers/, backend/src/lib/,
   backend/scripts/, backend/test/, enricher/? If so, reject.
5. Does it write to a database, add TypeScript, or widen its reach beyond the
   defect? If so, reject.
6. Is a value hardcoded for one event where a rule was needed?

Being unsure is a reason to request changes, not to approve.

## Answer

Reply with one JSON object and nothing else:

{
  "verdict": "approve" | "request-changes" | "reject",
  "reasoning": "two or three sentences",
  "concerns": ["..."],
  "breaks_other_cases": false
}`
}

// A reviewer that asks for changes used to end the story. The branch was pushed,
// the pull request was open, and the worktree it lived in was deleted at the end
// of the run, so #163 and #164 sat untouched. The reviewer's concerns are the
// most useful thing either agent produced: they name the case the author missed.
// Hand them back once.
export function revisePrompt({ group, review, branch, prNumber }) {
  const concerns = (review?.concerns || []).map((c, i) => `${i + 1}. ${c}`).join('\n')

  return `You wrote the change on branch ${branch} and opened pull request #${prNumber}.
A reviewer read the diff without seeing your reasoning and asked for changes.
Address what they said, or explain why they are wrong and change nothing.

## What the reviewer said

${review?.reasoning || '(no reasoning given)'}

## Their specific concerns

${concerns || '(none listed)'}

## What to do

1. Read each concern against the code you changed. A concern that names a case
   your change breaks is the one that matters most.
2. Where the reviewer is right, fix it, and extend the test in backend/test/ so
   the case they named is covered. Where the reviewer is wrong, leave the code
   alone and say so plainly in your answer.
3. Do not widen the change to make a point. The smallest change that answers the
   concern is the one that gets merged.
4. Run: npm test --workspace=backend
5. Commit on ${branch} and push. The pull request updates itself, so do not open
   a second one.

## Limits

The same limits as before. Only backend/src/scrapers/, backend/src/lib/,
backend/scripts/, backend/test/, enricher/. No database writes. No TypeScript.
No Co-Authored-By trailer.
${HOUSE_RULES}
## Answer

Finish with one JSON object and nothing else:

{
  "status": "revised" | "stands" | "failed",
  "pr_number": ${prNumber},
  "addressed": ["which concern, and what you changed"],
  "disputed": ["which concern you think is wrong, and why"],
  "summary": "one sentence"
}`
}
