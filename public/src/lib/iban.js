// Display an account number in 4-character groups (PL61 1090 1014 …).
// Only the input shows the groups; the server stores the normalized value.
export function groupIban(s) {
  const raw = String(s ?? '').replace(/\s+/g, '').toUpperCase()
  return raw.replace(/(.{4})(?=.)/g, '$1 ')
}
