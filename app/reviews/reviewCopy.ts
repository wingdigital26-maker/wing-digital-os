// Single source of truth for review-request message text. Pure, framework-free
// (no next/server, no "use client") so it can be imported by BOTH the server
// send route (app/api/reviews/send/route.ts) and the client reviews board
// (app/reviews/ReviewsBoard.tsx) without either one dragging the other's
// runtime into its bundle. Moved out of route.ts on 2026-09-15 so the manual
// "Copy SMS / Copy email" affordance can reuse the EXACT text the automated
// (currently off) send pipeline would use -- no re-invented copy, no drift.
//
// Honest, non-spammy review-request copy. Requires a REAL google_review_url --
// callers must not invoke these without one. No em dashes, no unrendered
// tokens, no phone-number CTA (the link is the only call to action).

export function smsBody(brand: string, first: string, reviewUrl: string): string {
  return (
    `Hi ${first}, this is ${brand}. Thank you for choosing us. ` +
    `If you have a minute, we would really appreciate a quick review: ${reviewUrl}`
  );
}

export function emailSubject(brand: string): string {
  return `Thanks for choosing ${brand}`;
}

export function emailBody(brand: string, first: string, reviewUrl: string): string {
  return (
    `Hi ${first},\n\n` +
    `Thank you for choosing ${brand}. It was a pleasure working with you.\n\n` +
    `If you have a moment, a short review would mean a lot and helps other ` +
    `local folks find us: ${reviewUrl}\n\n` +
    `Thank you so much,\n${brand}`
  );
}
