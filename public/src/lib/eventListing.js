// „Widoczność” of a leszy.run event. A published registration event is listed
// (events.visibility 'public') or link-only ('unlisted', registration_settings.listed false):
// published and working for anyone with the address, but on no listing, and its pages say
// noindex. Every listing filters visibility = LISTED_VISIBILITY.

export const LISTED_VISIBILITY = 'public'

/** An events row kept off every listing. */
export const isUnlistedEvent = (event) => event?.visibility === 'unlisted'

/** A /api/event snapshot of a link-only event (the organizer's preview carries no `listed`). */
export const isUnlistedRegistration = (raw) => raw?.listed === false
