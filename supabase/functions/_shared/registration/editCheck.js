// „Edytuj dane”, the check before organizer_edit_registration / runner_edit_registration: the form's
// own messages, keyed by field, so the dialog marks what is wrong. Shared by organizer-entry-action
// (the club) and my-entry-action (the runner, without the names).
import { validatePerson } from './person.js'
import { personContexts } from './registrationRequest.js'

// The fields the organizer's edit may change (ruling 7). Never the e-mail: the one-start key and the account.
export const EDITABLE = ['firstName', 'lastName', 'birthDate', 'gender', 'phone', 'city', 'club', 'nationality', 'iceName', 'icePhone']
// The runner's own edit: never the names either (a name change would sell the package past a disabled
// transfer; runner_edit_registration refuses them as field_not_allowed).
export const RUNNER_NOT_EDITABLE = ['firstName', 'lastName', 'email']
export const RUNNER_EDITABLE = EDITABLE.filter((k) => !RUNNER_NOT_EDITABLE.includes(k))

async function single(query) {
  const { data, error } = await query
  if (error) throw error
  return data
}

/**
 * validatePerson over the stored person with the edits applied. Only the fields the edit touches
 * can fail: a value stored before a form switch changed stays valid, as the RPC also decides. The
 * age group and kids' group are re-derived by the RPC under its locks; nothing computed here is
 * trusted (Task 2, decision 9).
 * → { invalid: { field: message } } (an empty object for a malformed request) | { keys }
 */
export async function checkEdit(admin, settings, registrationId, fields, { editable = EDITABLE } = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { invalid: {} }
  const keys = Object.keys(fields)
  if (!keys.length || keys.some((k) => !editable.includes(k) || (fields[k] !== null && typeof fields[k] !== 'string'))) {
    return { invalid: {} }
  }
  const reg = await single(admin.from('registrations')
    .select('category_id, first_name, last_name, birth_date, gender, email, phone, city, club, nationality, ice_name, ice_phone')
    .eq('id', registrationId).single())
  const competition = await single(admin.from('competitions').select('*').eq('category_id', reg.category_id).single())
  const context = (await personContexts(admin, settings, [competition])).get(competition.category_id)
  const stored = {
    firstName: reg.first_name, lastName: reg.last_name, birthDate: reg.birth_date, gender: reg.gender,
    email: reg.email, phone: reg.phone, city: reg.city, club: reg.club, nationality: reg.nationality,
    iceName: reg.ice_name, icePhone: reg.ice_phone,
  }
  const checked = validatePerson({ ...stored, ...fields }, { ...context, now: new Date() })
  const errors = Object.fromEntries(Object.entries(checked.errors).filter(([k]) => keys.includes(k)))
  return Object.keys(errors).length ? { invalid: errors } : { keys }
}
