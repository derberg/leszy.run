// The package transfer e-mails (Plan 7, §7). Pure: every input is passed in, so the same module runs
// in the edge functions and in node:test. No e-mail mentions a bib (numbers are the organizer's), a
// partner or a voucher, and none carries another person's address, phone or birth date. The money
// for a package is settled between the two people, outside LESZY.RUN: nothing here is payable.
import { escapeHtml, htmlBlock, isoDay, link, textBlock } from './emails.js'

// The sentence RA6 shows the sender, said to the recipient too.
export const MONEY_NOTE = 'Pieniądze za pakiet rozliczacie między sobą, poza LESZY.RUN. Nie zwracamy ich ani nie przekazujemy.'

const fullName = (p) => `${p?.firstName ?? ''} ${p?.lastName ?? ''}`.trim()

/** 'Konkurencja', 'Start' and 'Miejsce' facts, the empty ones left out. */
function raceFacts(event, competition) {
  const day = isoDay(event?.eventDate)
  const start = [day, competition?.startTime ? `godz. ${competition.startTime}` : null].filter(Boolean).join(', ')
  return [
    ['Konkurencja', competition?.name],
    ['Start', start || null],
    ['Miejsce', event?.place],
  ].filter(([, v]) => v)
}

const signature = { text: ['', 'LESZY.RUN'], html: '<p>LESZY.RUN</p>' }

/**
 * The invite to the address the sender typed. event { name, eventDate?, place? }, senderFirstName,
 * competition { name, startTime? }, link (`/przekazanie#<token>`: the only place the token appears),
 * until ('YYYY-MM-DD', the last day the link works, transfer_until).
 */
export function transferInviteEmail({ event, senderFirstName, competition, link: url, until }) {
  const sender = senderFirstName || 'Inna osoba'
  const facts = raceFacts(event, competition)
  const day = isoDay(until)
  const validity = day ? `Link działa do ${day} włącznie i tylko raz.` : 'Link działa tylko raz.'
  const free = 'Przyjęcie pakietu w LESZY.RUN nic nie kosztuje.'
  const source = `Twój adres e-mail podał(a) ${sender}, żeby przekazać Ci pakiet. Jeśli nie chcesz go przejąć, zignoruj tę wiadomość.`
  const text = [
    'Cześć,',
    '',
    `${sender} przekazuje Ci swój start w zawodach ${event.name}.`,
    '',
    ...textBlock(facts),
    '',
    `Przyjmij pakiet: ${url}`,
    '',
    `${validity} ${free}`,
    MONEY_NOTE,
    '',
    source,
    ...signature.text,
  ].join('\n')
  const html = [
    '<p>Cześć,</p>',
    `<p>${escapeHtml(sender)} przekazuje Ci swój start w zawodach <strong>${escapeHtml(event.name)}</strong>.</p>`,
    facts.length ? htmlBlock(facts) : '',
    link(url, 'Przyjmij pakiet'),
    `<p>${escapeHtml(validity)} ${escapeHtml(free)}<br>${escapeHtml(MONEY_NOTE)}</p>`,
    `<p>${escapeHtml(source)}</p>`,
    signature.html,
  ].join('')
  // The link carries the token in its fragment: no click-tracking redirect may rewrite it.
  return { subject: `${sender} przekazuje Ci start — ${event.name}`, text, html, trackClicks: false }
}

/**
 * To the sender, once the package was taken: who took it (their name only). event { name },
 * senderFirstName, recipient { firstName, lastName }.
 */
export function transferAcceptedEmail({ event, senderFirstName, recipient }) {
  const who = fullName(recipient) || 'Inna osoba'
  const greeting = senderFirstName ? `Cześć ${senderFirstName},` : 'Cześć,'
  const lead = `${who} przejmuje Twój pakiet na zawody ${event.name}. Nie jesteś już na liście startowej tych zawodów.`
  const text = [greeting, '', lead, '', MONEY_NOTE, ...signature.text].join('\n')
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(who)} przejmuje Twój pakiet na zawody <strong>${escapeHtml(event.name)}</strong>. Nie jesteś już na liście startowej tych zawodów.</p>`,
    `<p>${escapeHtml(MONEY_NOTE)}</p>`,
    signature.html,
  ].join('')
  return { subject: `Pakiet przejęła ${who} — ${event.name}`, text, html }
}

/** To the invited address, when the sender took the invite back. event { name }, senderFirstName. */
export function transferCancelledEmail({ event, senderFirstName }) {
  const sender = senderFirstName || 'Osoba, która Cię zaprosiła,'
  const lead = `${sender} cofnął(-ęła) zaproszenie do przejęcia pakietu na zawody ${event.name}. Link z poprzedniej wiadomości już nie działa.`
  const text = ['Cześć,', '', lead, ...signature.text].join('\n')
  const html = [
    '<p>Cześć,</p>',
    `<p>${escapeHtml(sender)} cofnął(-ęła) zaproszenie do przejęcia pakietu na zawody <strong>${escapeHtml(event.name)}</strong>. Link z poprzedniej wiadomości już nie działa.</p>`,
    signature.html,
  ].join('')
  return { subject: `Zaproszenie cofnięte — ${event.name}`, text, html }
}

/**
 * The recipient's confirmation („Jesteś na liście”). event { name, eventDate?, place?, url? },
 * person { firstName, ageGroupLabel? }, competition { name, startTime? }.
 */
export function transferConfirmationEmail({ event, person, competition }) {
  const greeting = person?.firstName ? `Cześć ${person.firstName},` : 'Cześć,'
  const facts = raceFacts(event, competition)
  if (person?.ageGroupLabel) facts.splice(1, 0, ['Kategoria', person.ageGroupLabel])
  const lead = `przejmujesz pakiet i jesteś na liście startowej zawodów ${event.name}.`
  const text = [
    greeting,
    '',
    lead,
    '',
    ...textBlock(facts),
    '',
    MONEY_NOTE,
    ...(event.url ? ['', `Strona zawodów: ${event.url}`] : []),
    ...signature.text,
  ].join('\n')
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>przejmujesz pakiet i jesteś na liście startowej zawodów <strong>${escapeHtml(event.name)}</strong>.</p>`,
    facts.length ? htmlBlock(facts) : '',
    `<p>${escapeHtml(MONEY_NOTE)}</p>`,
    event.url ? link(event.url, 'Strona zawodów') : '',
    signature.html,
  ].join('')
  return { subject: `Jesteś na liście — ${event.name}`, text, html }
}

/**
 * To the old holder, when the organizer handed their package on from B3 (ruling 4; controller
 * ruling M-2: fairness). Names the new holder by first name and surname only, never their address.
 * event { name }, holderFirstName, recipient { firstName, lastName }, organizer { name, contactEmail? }.
 */
export function transferByOrganizerEmail({ event, holderFirstName, recipient, organizer }) {
  const who = fullName(recipient) || 'inna osoba'
  const org = organizer?.name || 'Organizator zawodów'
  const greeting = holderFirstName ? `Cześć ${holderFirstName},` : 'Cześć,'
  const lead = `organizator zawodów ${event.name} (${org}) przekazał Twój pakiet tej osobie: ${who}. Nie jesteś już na liście startowej tych zawodów.`
  const contact = organizer?.contactEmail
    ? `Jeśli to pomyłka, napisz do organizatora: ${organizer.contactEmail}.`
    : 'Jeśli to pomyłka, napisz do organizatora.'
  const text = [greeting, '', lead, '', contact, ...signature.text].join('\n')
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(lead)}</p>`,
    `<p>${escapeHtml(contact)}</p>`,
    signature.html,
  ].join('')
  return { subject: `Pakiet przekazany — ${event.name}`, text, html }
}
