// The organizer's event as the wizard should show it (P2-R25): after publish,
// a section with staged changes (registration_pending_changes.payload, each
// the validated snake_case value save-registration-section staged) shows the
// staged value, not the live one, so a step that remounts or reloads keeps
// editing what is staged. A section with nothing staged shows live values.
// Returns the input when nothing is staged; the input is never changed.
import { warsawToday } from '../../../supabase/functions/_shared/registration/dates.js'

const camelKey = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const camel = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [camelKey(k), v]))

function basics(b) {
  const out = camel(b)
  if ('opens_at' in b) out.opensOn = b.opens_at ? warsawToday(new Date(b.opens_at)) : null
  if ('closes_at' in b) out.closesOn = b.closes_at ? warsawToday(new Date(Date.parse(b.closes_at) - 1)) : null
  return out
}

export function stagedEvent(event) {
  const payload = event?.pending?.payload
  if (!payload) return event
  const out = { ...event, settings: { ...event.settings } }

  if (payload.basics) Object.assign(out.settings, basics(payload.basics))
  if (payload.office) {
    const { hours, ...rest } = payload.office
    Object.assign(out.settings, camel(rest))
    if (hours) out.officeHours = hours.map((h) => ({ date: h.date, from: h.from, to: h.to }))
  }
  if (payload.competitions) {
    const v = payload.competitions
    if ('pricing_mode' in v) out.settings.pricingMode = v.pricing_mode
    if (v.items) {
      const live = new Map((event.competitions ?? []).map((c) => [c.categoryId, c]))
      out.competitions = v.items.map((i) => {
        const was = i.category_id ? live.get(i.category_id) : null
        const { price, hidden, ...rest } = camel(i)
        return {
          ...rest,
          categoryId: i.category_id ?? null,
          priceGrosze: price ?? null,
          taken: was?.taken ?? 0,
          hiddenAt: hidden === true ? (was?.hiddenAt ?? 'staged') : hidden === false ? null : (was?.hiddenAt ?? null),
        }
      })
    }
  }
  if (payload.categories) {
    const v = payload.categories
    if ('age_reckoning' in v) out.settings.ageReckoning = v.age_reckoning
    if (v.age_groups) out.ageGroups = v.age_groups.map(camel)
    if (v.kids_groups) out.kidsGroups = v.kids_groups.map(camel)
  }
  if (payload.timing) Object.assign(out.settings, camel(payload.timing))
  if (payload.form) {
    if ('form_fields' in payload.form) out.settings.formFields = payload.form.form_fields
    if (payload.form.consents) {
      out.consents = [
        ...(event.consents ?? []).filter((k) => k.kind !== 'custom'),
        ...payload.form.consents.map((k) => ({ id: k.id ?? null, kind: 'custom', text: k.text })),
      ]
    }
  }
  return out
}
