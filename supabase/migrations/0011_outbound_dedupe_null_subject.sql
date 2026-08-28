-- Applied live to the Sonar project (klzmpjregrcxumaxfsug).
--
-- Jackson Roofing showed "3 drafts" that were really 2, because the same post
-- had been drafted twice. The cause is a Postgres trap rather than a bug in the
-- scraper.
--
-- `outbound` already carries UNIQUE (client, channel, recipient, subject). That
-- constraint looks like it prevents exactly this. It does not, because `subject`
-- is NULL on every social reply (a Reddit or Nextdoor comment has no subject
-- line), and in Postgres NULL is never equal to NULL. A unique constraint
-- containing a NULL column constrains nothing, so every social row counted as
-- unique no matter how identical it was.
--
-- Measured before this migration: 44 rows had a null subject and 3 of them were
-- duplicate pairs (32/39, 33/40, 92/95). Two of those pairs share a URL but
-- carry different body text, so they are the same lead drafted twice with
-- different wording rather than a byte-for-byte repeat.
--
-- The fix uses coalesce so NULL participates in the comparison. It is PARTIAL,
-- covering only rows that can still be acted on. Rejected and skipped history is
-- left exactly as it is: that is an audit trail of what the gates caught, and
-- collapsing it would destroy evidence about how the funnel behaves.
--
-- No rows are deleted anywhere in this migration.

-- The one conflicting pair among actionable rows. Marking the later copy skipped
-- is a true statement about it: it is a duplicate that should never be worked.
-- Its twin, id 92, stays exactly as it was.
update public.outbound
   set status = 'skipped',
       reviewed_at = coalesce(reviewed_at, now())
 where id = 95
   and status = 'draft'
   and exists (
         select 1 from public.outbound o2
          where o2.id = 92
            and o2.client = public.outbound.client
            and o2.recipient is not distinct from public.outbound.recipient
       );

create unique index if not exists outbound_actionable_dedupe
    on public.outbound (client, channel, recipient, coalesce(subject, ''))
 where status in ('draft', 'approved', 'sent');

comment on index public.outbound_actionable_dedupe is
  'Stops the same lead being drafted twice. Uses coalesce because the existing
   UNIQUE constraint includes subject, which is NULL for every social reply, and
   NULL never equals NULL so that constraint never fired. Partial on purpose:
   rejected and skipped rows are funnel evidence and are allowed to repeat.';
