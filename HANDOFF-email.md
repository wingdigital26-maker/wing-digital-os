# Handoff from the email rebuild (branch `ui/crm-email`)

Three small changes live in files the email work does not own. Whoever owns them
should fold these in; nothing below is urgent enough to break anything if it is
skipped, but each one leaves a dead edge behind.

## 1. `app/page.tsx` line ~472 still mounts the texting view

```tsx
{visited.has("text") && <div className="app-view" style={{ display: active === "text" ? "block" : "none" }}><MessageLedger channel="sms" /></div>}
```

Texting is out of the CRM. `MessageLedger` no longer has an SMS surface: called
with `channel="sms"` it now renders one honest line saying texting is not part
of the CRM any more, and nothing else. The `channel` prop only survives so this
call site keeps type-checking.

Please delete the `text` view mount (and its `visited` / nav entry) entirely.
Once that is gone, the `channel` prop can come off `MessageLedger` too.

## 2. `app/page.tsx` mounts `ReplyInboxBoard` as its own top-level CRM tab

The email hub now carries Replies as its second view, sharing the feed's list
and reading pane. The separate top-level "Reply Inbox" tab shows the same board
twice in two places. If the nav is being simplified, that top-level tab is the
one to drop.

## 3. `app/api/messaging` still returns a `texts` key

`SendQueueBoard` no longer renders it. The key is harmless but dead; it can be
removed from the route whenever that file is next touched.

## Not a handoff, just so nobody re-adds it

`app/email/EmailComposer.tsx` (the standalone `/email` page) was deliberately
left alone. The hub now uses `app/components/email/Composer.tsx` instead, which
adds a real template picker sourced from the live campaign sequence steps. Both
post to the same gated `/api/email/send` and `/api/email/campaign`; neither one
can bypass the server's send gate.
