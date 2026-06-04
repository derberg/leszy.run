# DPA Checklist — Operator action items

> This file is git-ignored (see `.gitignore`). It tracks personal action items
> for the operator. Update as items are completed.

## Email + identity

- [ ] Confirm `lukasz@leszy.run` mailbox / forwarding works (test send + receive)
- [ ] Add `lukasz@leszy.run` to password manager
- [ ] Set up daily inbox check reminder

## Processor DPAs (sign / accept)

- [ ] Supabase — accept DPA in dashboard (Settings → Legal)
- [ ] Vercel — accept DPA in dashboard (Settings → Security & Privacy)
- [ ] SMSAPI sp. z o.o. — request DPA via panel.smsapi.pl, sign and store PDF
- [ ] Twilio / SendGrid — accept Twilio MSA in account settings
- [ ] Google Ireland Ltd. — accept GA4 Data Processing Terms in GA admin

## Provider configuration

- [ ] GA4: set data retention to 14 months (Admin → Data Settings → Data Retention)
- [ ] GA4: confirm IP anonymization is ON (default in GA4, but verify)
- [ ] GA4: turn OFF Google Signals (Admin → Data Settings → Data Collection)
- [ ] Supabase: enable 2FA on operator account
- [ ] Vercel: enable 2FA on operator account
- [ ] GitHub: enable 2FA + signed commits

## Operational

- [ ] Confirm backup recipe in [docs/scrapers.md](../scrapers.md) works end-to-end
- [ ] Schedule weekly inbox check for `lukasz@leszy.run` (data subject requests)
- [ ] Add `lukasz@leszy.run` to monitoring / alerting destinations
