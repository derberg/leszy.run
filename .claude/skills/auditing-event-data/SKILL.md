---
name: auditing-event-data
description: Use when a scraped calendar event published without full details, when asked "why is <event> not with all details", when reviewing the /calendar-events queue after run-publish, or when hardening a scraper, the merge, or the enricher against a data defect. Covers the four-layer trace, how to count the rows that share a defect, and the defect classes already found.
---

# Auditing event data

One event that published without its price, its regulamin or its distances is
almost never one event. The same scraper drops the same field on every race it
reads. So the question "why is this event incomplete" is a probe, and the answer
worth having is a fix to the code plus a count of how many rows it repairs.

This is the method that produced pull requests #104 to #118. The automated
version runs as `backend/scripts/run-prepublish-review.js`. Use this document
when you run it by hand.

## Fix the code, not the row

Do not fix the row. Fix the code that produced the row, then re-run the
pipeline. A corrected value typed into `scraper_all` or `calendar_events` is
gone at the next scrape, and it teaches you nothing about the other 900 rows.

## Step 1. Trace the field down four layers

Take one missing field on one event and find the first layer where it is absent.

| Layer | What it holds | How to read it |
|---|---|---|
| 1. `calendar_events` | what the public sees | `select * from calendar_events where source='<s>' and source_id='<id>'` |
| 2. `scraper_all` | the merged and enriched record | `select * from scraper_all where source='<s>' and source_id='<id>'` |
| 3. `scraper_<source>` | what the scraper captured | `select * from scraper_<source> where source_id='<id>'` |
| 4. the live source page | what the organizer published | `curl -sL <source_url>` |

Read the result:

| Absent at | Present at | The defect is in |
|---|---|---|
| 2 | 3 | the merge, `backend/src/scrapers/index.js` |
| 3 | 4 | the scraper, `backend/src/scrapers/sources/<source>.js` |
| 3 | nowhere | nobody published it. This is not a defect. |
| wrong at 1 | correct at 2 | the publish step, or a field lock |
| wrong everywhere | correct at 4 | an enricher overwrote a good value |

Layer 4 is the step people skip, and skipping it is how an agent invents a
scraper bug for a field the organizer never published. Fetch the page.

## Step 2. Count the rows that share the defect

Before you write any fix, count how many other rows carry the same defect. That
count is what makes one event a class of events, and it belongs in the commit
message.

```sql
-- how many rows of this source lost the same field
select count(*) from scraper_all
where source = '<source>' and regulamin_url is null and date >= current_date;

-- is the defect in one source or in the shared code
select source, count(*) filter (where regulamin_url is null) as missing, count(*) as total
from scraper_all where date >= current_date group by source order by missing desc;
```

One source means a scraper bug. Every source means shared code: the picker, the
merge, the enricher.

## Step 3. Fix behind a failing test

Write the test first and watch it fail. Tests live in `backend/test/` and use
`node:test`. Then make the smallest change, and run `npm test --workspace=backend`.

## Step 4. Propagate the fix into the data

A fixed scraper does not repair `scraper_all` on its own, because `run-merge`
only reads raw rows where `merged_at IS NULL`.

```bash
cd backend && node --env-file=../.env scripts/run-scrapers.js --only <source> --force <source>
# then clear the stamp so the merge reconsiders those rows:
#   UPDATE scraper_<source> SET merged_at = NULL WHERE date >= current_date;
cd backend && node --env-file=../.env scripts/run-merge.js --apply
cd backend && node --env-file=../.env scripts/run-normalize.js --apply
```

`--force` is required. Without it the scraper skips ids it already knows, and
the rows you are trying to repair are never re-fetched.

## Defect classes already found

New investigations keep landing on these. Check them before assuming something
new.

| Class | What it looked like | Where it was |
|---|---|---|
| Wrong document picked as the regulamin | 19 rows carried an `oswiadczenie` consent form. The scraper took the last PDF on the page. | `backend/src/lib/pickRegulaminUrl.js` now decides |
| A regulamin format the parser refuses | Kosakowo's rules are a `.docx`, the parser matched `.pdf` only, and 45 rows lost the field | `sources/zapisyonline.js` |
| A regulamin that is an HTML page | TKKF Koszalin serves its rules at `/mile`, not as a file | `sources/b4sport.js` |
| Free read as unknown | dostartu leaves the price array empty for free races, so 23 free events said "price unknown" | `sources/dostartu.js` reads `classificationSetting.isPay` |
| A known event never re-read | dostartu rows froze at first-scrape state, missing tiers added later | the `knownIds` skip |
| A source fix that cannot reach `scraper_all` | priority compared a source against itself, so a re-scrape always lost | `incomingWinsOver()` |
| A non-running event with no cycling word in its name | "Poranne Kręcenie" is a bike ride, "Nocny Rajd do Torunia" is a rajd rowerowy | the merge keyword filter, and `SKIP_KEYWORDS` |
| The wrong edition of a regulamin | The organizer links last year's rules, and the enricher reads prices out of them | `run-data-audit.js` flags the filename year |
| A silent crawler failure | Playwright could not start, every page logged as `failed`, and the run still exited 0 | `enricher` preflight |
| An enricher locked out by a scraper value | A scraper-written `0` price blocked the regulamin from correcting it | the scalar merge treats `0` as provisional |

## Traps

A 200 OK does not mean the URL is right. Follow the redirects with
`curl -sIL` and confirm the page carries the event name, the race id or the
date. A login page returns 200 and strips the race id.

The word regulamin means the rules. Polish timing sites publish an `oswiadczenie`,
a `klauzula RODO` and a course map on the same page. Picking by link order picks
the consent form. Because the enricher reads prices, deadline and distances out
of whatever it is given, one wrong link empties those fields or invents them.

A `price_from` of 0 is an answer. It means the race is free.

A locked field is already decided. The "brak" button in the admin list records that
a race genuinely has no regulamin. Do not investigate it again.

A field that is absent at source is not a bug. Say so and stop. If you invent a
scraper defect for data that nobody published, the fix you write then drops real
data somewhere else.

A wider keyword filter removes more than you intend. A rule that drops cycling events
whose name says `rowerow` also drops a running race called "Bieg Rowerowej
Doliny". Check what a new filter removes before shipping it.

## Related

- `.claude/skills/adding-a-new-scraper/SKILL.md` for a new source
- `.claude/skills/dev-workflow/SKILL.md` for the worktree and pull request flow
- `docs/scrapers.md` for the pipeline steps
