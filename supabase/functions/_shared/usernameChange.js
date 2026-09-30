// A username is claimed once and kept.
//
// update-profile accepted a change at any time, checking only the format and
// that nobody else holds it. There is no UI for it after onboarding, but the
// endpoint is reachable — and a change is not a local edit: /u/<old> is a
// public page other pages link to, there is no history table behind it (unlike
// a club slug, which parks its former slugs in club_slug_history and keeps
// redirecting), so every inbound link breaks AND the freed handle can be
// claimed by somebody else, who inherits those links.
//
// Renames and their redirects are deliberately not supported for now: someone
// who needs one writes in and it is done by hand.

export function usernameChangeError(current, incoming) {
  const now = String(current ?? '').trim().toLowerCase()
  const next = String(incoming ?? '').trim().toLowerCase()
  if (!now) return null // first claim, at onboarding
  if (now === next) return null // the settings page re-sends what it has
  return 'Nazwy użytkownika nie można zmienić. Napisz do nas, jeśli potrzebujesz zmiany.'
}
