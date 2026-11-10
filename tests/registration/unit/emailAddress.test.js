// The shared e-mail rule (_shared/registration/emailAddress.js) and its „Czy chodziło o …?”
// suggester. The rule replaced /^[^\s@]+@[^\s@]+\.[^\s@]+$/, which took `x@gmail..com`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidEmail, suggestEmail, emailProblem, EMAIL_INVALID_MESSAGE, KNOWN_DOMAINS } from '../../../supabase/functions/_shared/registration/emailAddress.js'
import { validatePerson } from '../../../supabase/functions/_shared/registration/person.js'
import { validateParent } from '../../../supabase/functions/_shared/registration/team.js'
import { isLoginEmail } from '../../../supabase/functions/_shared/loginEmail.js'

test('accepts real address shapes', () => {
  for (const ok of [
    'a@b.pl', 'jan.kowalski@gmail.com', 'first.last+tag@sub.example.com', 'a_b-c@x.io', 'o\'brien@x.ie',
    'x@my-club.com.pl', 'x@a.b.c.d.pl', 'x@żółw.pl', 'x@site.xn--p1ai', 'x@пример.рф', 'x@xn--80ak6aa92e.com',
    'JAN@GMAIL.COM', '1234@1and1.com', `${'a'.repeat(64)}@x.pl`,
  ]) assert.equal(isValidEmail(ok), true, ok)
})

test('refuses typos the old rule took', () => {
  for (const bad of [
    'niemczewskazofia0@gmail..com', // the trigger
    'a..b@x.pl', '.a@x.pl', 'a.@x.pl', 'a@.x.pl', 'a@x.pl.', 'a@x..pl',
    'a@-x.pl', 'a@x-.pl', 'a@x.-pl', 'a@x.p', 'a@x.c0m', 'a@x.123', 'a@1.2.3.4',
    'a b@x.pl', 'a@x .pl', ' a@x.pl', 'a@x.pl ', 'a@b', 'a@@x.pl', 'a@b@x.pl', '@x.pl', 'a@',
    'a,b@x.pl', 'a@x.pl,target.eq.x', 'a(b)@x.pl', 'a"b@x.pl', 'a<b>@x.pl', 'a\\b@x.pl', 'a\u0000@x.pl',
    `${'a'.repeat(65)}@x.pl`, `a@${'b'.repeat(64)}.pl`, `${'a'.repeat(60)}@${'b.'.repeat(97)}pl`,
    '', null, undefined, 42,
  ]) assert.equal(isValidEmail(bad), false, String(bad))
})

test('every server path uses the rule: person, parent, login', () => {
  const ctx = { competition: { minAge: null, maxAge: null }, raceDate: '2027-06-01', reckoning: 'birth_date', formFields: {}, now: new Date('2026-11-10T12:00:00Z') }
  const person = { firstName: 'Zofia', lastName: 'N', email: 'zofia@gmail..com', birthDate: '1990-01-01', gender: 'K', phone: '+48 600 000 000' }
  assert.ok(validatePerson(person, ctx).errors.email)
  assert.equal(validatePerson({ ...person, email: 'zofia@gmail.com' }, ctx).errors.email, undefined)
  assert.ok(validateParent({ firstName: 'A', lastName: 'B', email: 'a@wp..pl' }).errors.parentEmail)
  assert.equal(isLoginEmail('a@gmail..com'), false)
  assert.equal(isLoginEmail('a@gmail.com'), true)
})

test('suggests the provider for common typos', () => {
  const cases = {
    'niemczewskazofia0@gmail..com': 'niemczewskazofia0@gmail.com',
    'jan@gmial.com': 'jan@gmail.com',
    'jan@gmail.con': 'jan@gmail.com',
    'jan@gmail.co': 'jan@gmail.com',
    'jan@gmai.com': 'jan@gmail.com',
    'jan@gamil.com': 'jan@gmail.com',
    'jan@gmailcom': 'jan@gmail.com',
    'jan@gmail.pl': 'jan@gmail.com',
    'jan@gmail.com.': 'jan@gmail.com',
    'Jan@Gmial.Com': 'jan@gmail.com',
    'jan@wp.p': 'jan@wp.pl',
    'jan@wp.com': 'jan@wp.pl',
    'jan@wp,pl': 'jan@wp.pl',
    'jan@o2.com': 'jan@o2.pl',
    'jan@0net.pl': 'jan@onet.pl',
    'jan@onet.p': 'jan@onet.pl',
    'jan@onte.pl': 'jan@onet.pl',
    'jan@interia.p': 'jan@interia.pl',
    'jan@intreia.pl': 'jan@interia.pl',
    'jan@inetria.pl': 'jan@interia.pl',
    'jan@hotmial.com': 'jan@hotmail.com',
    'jan@outlok.com': 'jan@outlook.com',
  }
  for (const [typed, want] of Object.entries(cases)) assert.equal(suggestEmail(typed), want, typed)
})

test('suggests nothing for known, unknown or ambiguous domains', () => {
  for (const d of KNOWN_DOMAINS) assert.equal(suggestEmail(`jan@${d}`), null, d)
  for (const none of [
    'jan@travelping.com', 'jan@leszy.run', 'jan@zatyrani.pl', 'jan@uni.wroc.pl', 'jan@mail.com',
    'jan@ip.pl', // one edit from wp.pl, op.pl and vp.pl: no single guess
    'jan', 'jan@', '@gmial.com', '', null,
    'a..b@gmial.com', // the domain is fixable but the local part is not: offering it would mislead
  ]) assert.equal(suggestEmail(none), null, String(none))
})

test('emailProblem says what is wrong, and nothing for a valid address', () => {
  assert.equal(emailProblem('Jan@Gmail.com'), null)
  assert.equal(emailProblem(' jan@gmail.com '), null)
  assert.equal(emailProblem('zofia@gmail..com'), 'Adres ma dwie kropki obok siebie.')
  assert.equal(emailProblem('jan.@gmail.com'), 'Kropka nie może stać na początku ani na końcu adresu.')
  assert.equal(emailProblem('jan@gmail.com.'), 'Kropka nie może stać na początku ani na końcu adresu.')
  assert.equal(emailProblem('jan kowalski@gmail.com'), 'Adres e-mail nie może zawierać spacji.')
  assert.equal(emailProblem('jan.gmail.com'), 'Adres e-mail musi zawierać jeden znak @.')
  assert.equal(emailProblem('jan@@gmail.com'), 'Adres e-mail musi zawierać jeden znak @.')
  assert.equal(emailProblem('@gmail.com'), 'Brakuje części przed znakiem @.')
  assert.equal(emailProblem('jan@'), 'Brakuje części po znaku @.')
  assert.equal(emailProblem('jan@gmail'), 'Brakuje końcówki domeny, np. .pl lub .com.')
  assert.equal(emailProblem('jan@-gmail.com'), EMAIL_INVALID_MESSAGE)
  assert.equal(emailProblem(''), EMAIL_INVALID_MESSAGE)
})
