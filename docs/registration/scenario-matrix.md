# Registration scenario matrix

Every scenario, its expected result and where it is tested. Later plans append rows.
`manual ✔` is ticked by a person after a manual check on the local stack.

| ID | Scenario | Expected | Layer | Test | manual ✔ |
|----|----------|----------|-------|------|----------|
| F-01 | Anon cannot select any of the six new registration tables | denied | DB | `tests/registration/schema.test.js` › F-01 anon cannot select any of the six new registration tables |  |
| F-02 | Updating registration_settings.club_id | raises | DB | `tests/registration/schema.test.js` › F-02 registration_settings.club_id cannot be changed; other columns can |  |
| F-03 | Deleting participant/category/event/check-in/checkpoint/race run/document of an event with registration_settings | raises; same deletes without it succeed | DB | `tests/registration/schema.test.js` › F-03 deletes of a registration event and its rows are refused; F-03 the same deletes on an event without registration succeed |  |
| F-04 | Participant with removed_at | absent from participants_public and search_participants_admin; anon access otherwise intact | DB | `tests/registration/schema.test.js` › F-04 a removed participant is hidden from participants_public and the PIN RPCs |  |
| F-05 | delete-club on a club without events / owning a registration event | 200 / 409 | edge function | `tests/registration/schema.test.js` › F-05 delete-club: 200 for a club without events, 409 for a club owning a registration event; F-05 merge_clubs refuses …; F-05 merge_clubs is not callable by anon |  |
| F-06 | Seed club zatyrani-test vs inny-klub | registration_enabled true / false | DB | `tests/registration/schema.test.js` › F-06 seed: zatyrani-test has registration enabled, inny-klub does not |  |
| F-07 | registration_waitlist rows per club | one | DB | `tests/registration/schema.test.js` › F-07 registration_waitlist holds one row per club |  |
| F-08 | configSync pulls legacy, published and closed leszyrun events; skips draft and external | as stated | unit | Task 2 (pending) |  |
| F-09 | A skipped event | drops its categories, participants, checkpoints, race_runs, results, event_documents | unit | Task 2 (pending) |  |
| F-10 | Draft skipped on poll 1, published by poll 2 | pulled on poll 2 | unit | Task 2 (pending) |  |
| F-11 | settingsFailed / loadHostFilter paging | known local event pulled, unknown skipped; errors flagged; every page read | unit | Task 2 (pending) |  |
| F-12 | seedStatus cases | as specified in the plan | unit | Task 3 (pending) |  |
| F-13 | isRegistrationEvent | as specified | unit | Task 3 (pending) |  |
| F-14 | Removed participant | excluded from the detector start list (startListFor) | unit | Task 3 (pending) |  |
| F-15 | Login module: valid captured code / wrong code / retired address | ok + cookie / 401 / 403 email_retired | integration | Task 4 (pending) |  |
| F-16 | Retired address on the login page | exact message shown | e2e | Task 4 (pending) |  |
| F-17 | Club status for a member of a disabled club; waitlist join | enabled:false; 200 and one operator email, second join still one row | edge function | Task 5 (pending) |  |
| F-18 | Agreement acceptance | owner of enabled club accepted; admin 403; stale version 409; disabled club 404; non-member 403; organizer_actions row | edge function | Task 5 (pending) |  |
| F-19 | Payout details (IBAN/NIP) | validators; admin 403; owner 200 with history and email; invalid 400; organizer_actions row | edge function | Task 6 (pending) |  |
| F-20 | Organizer onboarding across audiences (owner/admin/member) | waitlist copy, agreement acceptance, disabled new-event button, masked IBAN | e2e | Task 7 (pending) |  |
