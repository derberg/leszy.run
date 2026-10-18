// A participant who came but will not start ("Nie startuje" in the participants
// table). The flag lives on the participant because it is set before the gun,
// when no result row exists yet; race start then seeds the result as DNS.
//
// It is a pre-race tool only. Once a race run holds a result for the runner, the
// status is changed in Przegląd trasy, where the operator works during the race.

/**
 * Why a withdrawal, or undoing one, is refused, or null when it may go ahead.
 * @param {number} liveResults the runner's results in race runs that were not cancelled
 * @returns {string|null}
 */
export function withdrawalRefusal(liveResults) {
  return liveResults > 0 ? 'Bieg już wystartował. Zmień status w Przeglądzie trasy.' : null
}
