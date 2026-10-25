// The public club page (/klub/:slug, generate-club-pages.js) is parked: its
// manifest is deliberately []. While it is, every control that decides what
// that page shows is hidden, and new memberships default to clubmates-only.
export const PUBLIC_CLUB_PAGE_SHIPPED = false

// hidden_public for a membership created before anyone can choose: off the
// public page until the person decides otherwise.
export const DEFAULT_HIDDEN_PUBLIC = true
