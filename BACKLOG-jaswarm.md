# jaswarm backlog

Deferred items the loop should drain when the current level runs dry.

- [ ] Tokenize the duplicated OUTCOMES/tier hex palette shared verbatim across app/calls/list/page.tsx, app/calls/page.tsx, app/calls/callbacks/page.tsx (deferred R3: fixing in one file only would fragment cross-page consistency; needs a coordinated single-owner pass on a shared constants module).
- [x] Dial list (/calls/list) shows no overdue urgency for callback-status leads. DONE 2026-09-15: ported the Callbacks red treatment (var(--red) border/background via color-mix, matching pill) plus a subtle muted "due in Xhr"/"Xhr late" label for non-overdue callbacks. See journal 2026-09-15 entry.
