# Profil hub redesign — design

**Date:** 2026-07-14
**Status:** approved (brainstorm)
**Scope:** `public/` app only. The authenticated `/profil` area, gated behind `useBeta()`.

## Problem

`public/src/pages/Profil.jsx` (747 lines) crams everything onto one scrolling page:
a left sidebar with the avatar, badges, **all** editable profile fields, and
notification/privacy toggles; a main column with observed events + a notifications
feed + contributions; and a danger zone at the bottom. On mobile the sidebar stacks
on top, so a runner scrolls through every profile-settings field before reaching the
content they came for.

The root cause is not just layout — **settings and content are interleaved.** Editable
profile fields sit next to observed events. The area is also expected to grow (race
results/history, club/community, achievements/stats), which the current single-page
structure cannot absorb without getting worse.

## Goal

Turn `/profil` into a responsive **account hub** that:

- separates *browsing content* from *settings*,
- is mobile-first and uncluttered,
- deep-links each section to its own URL,
- has room to grow (results, achievements, club) without re-bloating,
- stays within the existing OVERDRIVE theme, `useBeta()` gating, and current
  edge-function data sources — no new dependencies, no new backend.

## Information architecture

**Persistent profile header** on every sub-view: avatar · `@username` · club ·
compact badge row · a **gear icon** (top-right) linking to Settings.

Two kinds of destinations:

### Content sections (navigation)
- **Obserwowane** — observed events + notifications feed. **Default landing.**
- **Zgłoszenia** — contributions (reports + new-event submissions), with the
  existing status filter (all / pending / accepted / rejected).
- **Wyniki** — runner's race results/history. *Future — nav slot reserved, NOT built now.*
- **Osiągnięcia** — badges + stats/streaks. *Future — nav slot reserved, NOT built now.*

### Settings (gear icon, not a browse tab)
`/profil/ustawienia`, one view with three subsections:
- **Dane osobowe** — name, club, gender, date of birth, phone, city, voivodeship.
- **Powiadomienia i prywatność** — weekly digest toggle, club-visibility toggle.
- **Twoje dane i konto** — export JSON, delete account (the current `DangerZone`).

Separating settings from content is the primary declutter win: profile fields stop
competing with events, and the danger zone leaves the bottom of the main scroll.

**Badges:** compact row in the header now (visible on every sub-view). When the
future Osiągnięcia section is built, the full grid moves there; the header keeps a
short row/count.

## Navigation pattern (responsive, always visible)

Same section list, reflowed by breakpoint:

- **Desktop (≥ md):** left rail of section links next to the content — dashboard feel,
  scales to the future sections.
- **Mobile (< md):** horizontal tab strip pinned under the header. Kept to the ~4
  content sections (settings is the gear icon, not a tab) so tabs fit without
  scrolling off-screen. Tabs beat a hamburger drawer here because navigation stays
  discoverable.

The active section is highlighted (OVERDRIVE: acid-yellow underline/left-edge, sharp
edges, no pills).

## URL sub-routes

Nested routes under `/profil`:

- `/profil` → redirect to `/profil/obserwowane` (the default).
- `/profil/obserwowane`
- `/profil/zgloszenia`
- `/profil/ustawienia`
- *(future)* `/profil/wyniki`, `/profil/osiagniecia`

Each is deep-linkable, browser back works, and each section renders its own focused
view with its own skeleton. Future sections slot in as new routes with no change to
the layout. All routes stay behind `useBeta()` (redirect home when off), exactly as
`/profil` is today.

Routing wiring: `App.jsx` currently has a single `<Route path="/profil">`. This
becomes a parent route (`/profil/*` or a nested `<Route>` block) rendering the Profil
layout, with child routes for each section and an index redirect to `obserwowane`.
Uses the existing react-router setup — no router change.

## Code structure

`Profil.jsx` at 747 lines does too much and should be split regardless.

- **`pages/Profil.jsx`** → thin **layout**: `AuthGuard` → fetch shared profile +
  badges **once** → provide them via context → render the header + section nav +
  nested-route outlet. Handles the loading / load-error states for the shared data.
- **Section components**, each its own file under `public/src/pages/profil/`:
  - `Obserwowane.jsx` — observed events list + notifications feed + the "Skąd biorą
    się powiadomienia?" help panel. Uses `useFavorites` + `useNotifications`.
  - `Zgloszenia.jsx` — contributions list, status filter, "Co to są zgłoszenia?"
    help panel.
  - `Ustawienia.jsx` — the three settings subsections; imports the editable-field
    components and `DangerZone`.
- **Shared field components** extracted to `public/src/components/profil/`
  (or a single `EditableFields.jsx`): `EditableField`, `EditablePhoneField`,
  `EditableClubField`, plus the phone parse/normalize/format helpers and
  `PencilIcon`. Imported by `Ustawienia.jsx`.
- **`DangerZone`** extracted to its own component, rendered inside `Ustawienia`.
- **Shared profile data**: a small context (e.g. `ProfilContext`) created in the
  layout holds `{ profile, badges, reports, submissions, handleSave, handleClubSave }`
  so switching tabs does not refetch or flash. `get-profile-data` is still called
  once by the layout; `handleSave`/`handleClubSave` update the shared `profile`.
  `useFavorites` / `useNotifications` stay as hooks used by `Obserwowane.jsx`.

No changes to edge functions, DB, or data flow — this is a client-side restructure of
existing data and components.

## Non-goals (YAGNI)

- Do **not** build Wyniki or Osiągnięcia sections now — only reserve their nav slots
  in a way that is trivial to fill later.
- No overview/dashboard landing — default straight to Obserwowane.
- No new backend endpoints, DB columns, or dependencies.
- No changes to auth, `useBeta` gating semantics, or the OVERDRIVE theme tokens.

## Testing

- The e2e suite forces `useBeta` on via `beta-storage.json`. Existing `data-testid`
  hooks (`profil-page`, `input-*`, `save-*`, `edit-*`, `toggle-weekly-digest`,
  `toggle-club-visibility`, `starred-list`, `notifications-feed`) must be preserved on
  the same elements after the move so current e2e tests keep passing.
- Add coverage for: default redirect `/profil` → `/profil/obserwowane`; deep-linking
  each section URL; nav highlights the active section; the gear icon reaches
  Ustawienia; settings edits still persist.
- Manual check on a narrow mobile viewport: header + tab strip fit, no horizontal
  body scroll, danger zone only reachable inside Ustawienia.

## Risks

- **Preserving test hooks** across the file split — mitigated by keeping the same
  `data-testid`s on the moved elements.
- **Shared-data context vs. refetch flash** — the layout must load shared data before
  rendering sections so tab switches are instant.
