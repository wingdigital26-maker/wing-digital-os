# jaswarm backlog

Deferred items the loop should drain when the current level runs dry.

- [ ] Tokenize the duplicated OUTCOMES/tier hex palette shared verbatim across app/calls/list/page.tsx, app/calls/page.tsx, app/calls/callbacks/page.tsx (deferred R3: fixing in one file only would fragment cross-page consistency; needs a coordinated single-owner pass on a shared constants module).
- [ ] Dial list (/calls/list) shows no overdue urgency for callback-status leads: a lead bright-red on Today and Callbacks looks identical to one due next week here. Port the overdue left-border/red-pill treatment (read next_action_at + a bucket) into the list card. (Practicality R3 #2 — real "loudest not loudest" gap, deferred as a Round 4 feature.)
