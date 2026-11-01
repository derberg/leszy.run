// Who an organizer's e-mail comes from. Sent from the LESZY.RUN domain with the club as display name
// and the event's contact address as reply-to (ruling P2-R19): never a member's own address, the
// owner's or the caller's. Shared by publish-registration-event's change notice, the organizer's
// messages and the refund e-mail.

/** → { fromName: '<klub> przez LESZY.RUN', replyTo: registration_settings.contact_email | undefined } */
export async function clubSender(admin, settings) {
  const { data: club, error } = await admin.from('clubs').select('name').eq('id', settings.club_id).single()
  if (error) throw error
  return { fromName: `${club.name} przez LESZY.RUN`, replyTo: settings.contact_email ?? undefined }
}
