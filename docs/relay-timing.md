# Relay timing (sztafeta) — how it works and how to run it

This page covers relays where a team runs laps **in any order** and one member may run
several laps (`categories.team_mode = 'relay_free'`, the default for a team competition, e.g.
Sztafeta Mikołajów in Szubin: a 400 m stadium lap, teams of 4–5, most laps wins). A fixed-order
relay (`'relay'`, leg k starts at leg k-1's finish) is described in CLAUDE.md, "Team categories".

The team is never timed by a result row of its own. Every lap is one `team_laps` row; the
standings, lap numbers and lap times are derived from those rows by `computeTeamResults()` in
`@leszyrun/ui`, the same code for the admin panel and the public results page.

## Two ways to count laps

Each `relay_free` category has a lap source (`categories.team_lap_source`), set in the event's
**Zespoły** tab („Liczenie okrążeń”: „pałka” / „zawodnicy”):

| Source | What closes a team lap | Use it when |
|---|---|---|
| `runner` (default) | the pass of any team member's own bib tag | nobody stands near the antenna except runners passing it |
| `baton` | the pass of the team's baton tag only | the antenna is on the exchange line (the normal stadium setup) |

The source cannot be changed while the category has an active race run.

### Why the baton exists (desk test, 2026-11-21)

Counting from bib tags with the antenna on the exchange line failed in a 20-runner desk test:

- a teammate waiting for the exchange stands inside the antenna's range, so the gate cannot tell
  who arrived and who is waiting;
- a slow approach is first heard weakly from several metres away, and a pass closes after 2 s
  without a stronger read, so the lap was timed on a far read (−73 dBm) before the runner reached
  the line (−34 dBm a few seconds later);
- when two members of a team were in range together, whichever tag was heard first took the lap
  and the other was rejected as too soon;
- one stray −72 dBm read of an unrelated tag became a lap.

Moving the antenna to the far side of the stadium fixes counting but breaks individual results:
the antenna then sees each runner once, mid-lap, so a "lap time" is half of one runner's lap plus
half of the next one's. The baton on the exchange line is the only setup that gives correct team
results and correct individual lap times: the baton crosses the line at the start and the end of
every lap, and is always with whoever is running.

## Baton mode — the rules

**One baton, one team, one tag.** A team has at most one baton with one tag (`team_batons`, the
row id is the team id). A baton's tag may not also be a runner's tag, and no two teams share a
tag: both are refused when assigning. A clash that arrives through sync shows as „Tag pałki jest
też tagiem zawodnika” in Zespoły and Sterowanie; until it is fixed the tag counts as the runner's
and the team gets no baton laps.

**Only the baton closes a lap.** A baton pass is handled with the same rules as any lap pass:

- it opens on a read of a tag that was silent for at least `lap_arrival_silence_seconds` (event
  setting „Cisza przed okrążeniem”, default 15 s) — a baton held at the line does not lap;
- it must come at least `min_finish_seconds` after the team's previous lap (and after the gun);
- it is timed at the peak (strongest read) of the pass, closing 2 s after the last stronger read
  and never later than 6 s after the first read;
- `confirm_rssi_cdbm`, when set, must be reached by the peak;
- `team_lap_count` and `team_time_limit_seconds` work as in runner mode.

**Runner tags never close a lap.** Their reads are grouped into bursts (a new burst after 5 s
without a read). A burst "came from the course" when that tag had been silent for the arrival
silence before it. Runner bursts do two things:

1. **Attribution — who ran the lap.** When a baton lap closes, timed at T (the baton's peak), the
   team members whose from-the-course burst started between T − 10 s and T + 2 s qualify. Exactly
   one → the lap is credited to them. None, or two or more → the lap counts for the team with
   **no runner** („bez biegacza”) and the operator picks one. A teammate who walked up to wait
   qualifies only if they arrived less than 10 s before the baton; one already standing at the
   line was read continuously and never qualifies.
2. **Candidates — a possible lap without the baton.** A from-the-course burst becomes a
   **candidate** (`team_laps.status = 'candidate'`) when no baton lap of the team falls between
   10 s before the burst started and 10 s after its last read, and at least `min_finish_seconds`
   have passed since the team's last counted lap. It is decided 15 s after the runner's last read
   (5 s burst gap + 10 s window), timed at the runner's strongest read, and at race stop for
   bursts not yet decided. **A candidate never
   counts** — not in standings, lap numbers or public results — until the operator presses
   „Zalicz”.

Every window value (5 s, 10 s, 2 s, 10 s) is a first choice from the design, to be tuned from a
real-pace test (`backend/src/mqtt/batonRelay.js`). Runner reads ignore `confirm_rssi_cdbm` (only
the tracking floor applies), so a far read can start a burst early: a runner first heard more than
10 s before the baton's peak gets no credit. After `team_time_limit_seconds` a candidate can still
be raised until the team's first baton pass after the limit; do not „Zalicz” one that falls
after the limit.

**Baton changes during a race.** Assigning or changing a baton reloads the running race at once on
this host, and on another host when its next sync pull brings the change (up to about a minute). A newly mapped tag counts as just
read, because it is usually scanned at the gate to assign it: it cannot close a lap until it has
been silent for the arrival silence.

**A team with no baton** still races: it gets no counted laps, only candidates the operator
approves. The Zespoły tab shows „brak pałki” for it, and Sterowanie „Brak pałki: <teams>”.

## Known limits

| Situation | What happens | What the operator does |
|---|---|---|
| The baton's read is missed and the runner leaves the zone | the runner's burst becomes a candidate; often the teammate who walked up also does, so one lap raises two candidates marked „to samo okrążenie?” | „Zalicz” one; the panel offers to reject the other |
| The baton's read is missed and the runner who brought it **stays in the exchange zone while a teammate runs the next lap** | no candidate (their reads run into the next baton lap); the missed lap is folded into the next one, which is about twice as long | the lap is marked „możliwe pominięte okrążenie” (longer than 1.7× the team's median, from 3 counted laps); add the missing lap with „+ Okrążenie” |
| A teammate steps into range less than 10 s before the baton arrives | two members qualify, the lap has no runner | pick the runner in „Do decyzji” |
| A family team with very different paces | a child's lap can trip the 1.7× flag | „Zatwierdź” |
| The host restarts mid-race | burst history is lost: runners at the line count as just arrived (laps with no runner, extra candidates), bursts that ended in the 15 s before the restart are never decided, and a baton lying at the antenna can count one extra lap | check „Do decyzji” and remove extras |
| A host still on code from before baton mode | it ignores the lap source, counts candidates as laps and cannot pull laps with no runner | update every host that holds the event before the race |

## Operator panel (Wyniki → „okrążenia drużyn”)

- **Do decyzji** (top): candidates, counted laps with no runner, and laps flagged
  „możliwe pominięte okrążenie”.
- **Per team**: every lap — number (counted laps only), clock time, lap time, runner or
  „bez biegacza”, source (pałka / chip / ręcznie), peak RSSI, state (liczone / zatwierdzone /
  kandydat / odrzucone).
- **Actions**: change the runner (same team only), change the time, „Zatwierdź” (a review mark;
  the lap already counts), „Zalicz” (counts a candidate), „Odrzuć” (asks first for a counted lap;
  the row keeps `deleted_at` and can be restored, because a DELETE would not reach other hosts),
  „+ Okrążenie” (add a lap by hand).
- **Według biegaczy**: the same laps grouped per runner.

Individual results (laps per runner, fastest lap) leave out candidates and laps with no runner, so
assigning runners in „Do decyzji” is what completes them.

## Race-day checklist (baton mode)

Before the day:

1. Every backend host that holds the event (checkpoint1, the Mac) runs code from `main` after the
   baton-mode merge (`~/leszyrun/scripts/update-pi.sh` on a Pi), and the Supabase migration
   `20261121150000_relay_baton` has been released.
2. Event settings: „Ignorowanie mety po starcie (sekundy)” (`min_finish_seconds`, default **300**:
   no lap faster than 5 min counts until you lower it) below the fastest possible lap (about 45 s
   for 400 m); „Cisza przed okrążeniem (sekundy)” (`lap_arrival_silence_seconds`, default 15)
   below the time a runner spends out of range on one lap.
3. Category: lap source „pałka” (Zespoły tab).
4. One tag per baton, fixed at the top end of the baton (a hand around the tag absorbs the
   signal). Assign each in the Zespoły tab; check that no team shows „brak pałki” or a tag clash.
   Every runner keeps their own bib tag, assigned and in their team: without it their laps come
   out „bez biegacza”.
5. Test at real pace: at least 50 baton passes; every pass must produce a lap. Note how often
   laps come out „bez biegacza” and whether the 1.7× flag fires on real laps.

At the venue:

6. The antenna on the start/exchange line; the gun is fired on that line.
7. Only the waiting runner and the arriving runner stand at the line. The next runner is at the
   line at least 10 s before the baton arrives. The arriving runner may stay in the exchange zone
   to wait for a later turn, or leaves when another teammate comes to wait. Spare batons and spare
   tags stay well out of range (more than about 6 m).

During the race:

8. Keep „Do decyzji” short: assign runners, decide candidates, check flagged laps.
9. Do not change the lap source; it is refused while the run is active.

After the race:

10. Clear „Do decyzji” after the race: decide every candidate (Zalicz or Odrzuć) and give every
    lap a runner where you can. The public page is live and shows a lap with no runner as
    „bez biegacza”; candidates never appear there.

## Where the code is

| Part | File |
|---|---|
| Pass rules, baton and runner paths | `backend/src/mqtt/crossingDetector.js` |
| Bursts, attribution, candidates | `backend/src/mqtt/batonRelay.js` |
| Batons per race, reload after restart | `backend/src/lib/batonConfig.js`, `backend/src/lib/reloadActiveRaces.js` |
| Baton sync and reload on pull | `backend/src/sync/configSync.js`, `backend/src/sync/supabase.js` |
| Missing-baton and clash helpers | `frontend/src/lib/batons.js` |
| Baton API and refusals | `backend/src/routes/teamBatons.js`, `backend/src/lib/teamBatons.js` |
| Lap corrections | `backend/src/routes/teamLaps.js`, `backend/src/lib/teamLapEdits.js` |
| Team standings and runners | `packages/ui/src/lib/teamResults.js` |
| Zespoły tab | `frontend/src/components/Teams/TeamsTab.jsx` |
| Lap panel and review rules | `frontend/src/components/TeamLaps/TeamLapsPanel.jsx`, `frontend/src/lib/teamLapReview.js` |
| Migrations | `backend/src/db/migrations/0045_relay_baton.sql`, `supabase/migrations/20261121150000_relay_baton.sql` |
