# jaswarm backlog

Deferred items the loop should drain when the current level runs dry.

- [ ] Tokenize the duplicated OUTCOMES/tier hex palette shared verbatim across app/calls/list/page.tsx, app/calls/page.tsx, app/calls/callbacks/page.tsx (deferred R3: fixing in one file only would fragment cross-page consistency; needs a coordinated single-owner pass on a shared constants module).
- [x] Dial list (/calls/list) shows no overdue urgency for callback-status leads. DONE 2026-09-15: ported the Callbacks red treatment (var(--red) border/background via color-mix, matching pill) plus a subtle muted "due in Xhr"/"Xhr late" label for non-overdue callbacks. See journal 2026-09-15 entry.
- [ ] Call panels lack role="dialog"/aria-modal + focus-trap across all three screens (list/page.tsx, callbacks/page.tsx, and any modal on page.tsx). Do as ONE coordinated a11y pass so the pattern is identical (flagged R5).
- [ ] HIGH VALUE (R6 target): Callbacks panel is a stripped-down copy of the Dial list panel. Missing: createPortal (header-overlap risk on tall panels), 1-5 outcome keys + hint, per-card quick-log row, and the intel surface (angle/"Say this", chips, tier pill, cautions box). Bring to parity - same Lead shape / same /api/calls/leads source. Investigate what the callbacks endpoint returns first; portal + keyboard parity are safe now, intel boxes only if the fields are present (else flag an API follow-up).
