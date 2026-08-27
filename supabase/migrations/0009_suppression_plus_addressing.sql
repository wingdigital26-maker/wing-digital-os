-- Applied live to the Sonar project (klzmpjregrcxumaxfsug).
--
-- Adversarial verification found that suppression compared addresses with
-- lower() and btrim() on both sides, which is correct as far as it goes, but
-- treats info+anything@example.com as a different address from
-- info@example.com. Those are the SAME mailbox on every major provider, so a
-- suppressed person could still be mailed by adding a plus tag.
--
-- Proved live: with info@allentxmover.com suppressed, a row addressed to
-- info+test@allentxmover.com appeared in outbound_sendable.
--
-- Fix: canonicalize by stripping the plus tag from the local part before
-- comparing, on BOTH sides. A helper function so the view and any future
-- consumer cannot drift apart, which is how the two layers ended up agreeing on
-- the same incomplete check last time.
--
-- Deliberately NOT doing: stripping dots from local parts. Gmail ignores them,
-- most other providers do not, so treating a.b@ and ab@ as one address would
-- wrongly suppress real people on non-Gmail domains. Over-suppressing is safer
-- than under-suppressing, but not when it silently removes valid prospects.

create or replace function public.canonical_email(addr text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(btrim(coalesce(addr, ''))), '\+[^@]*@', '@');
$$;

comment on function public.canonical_email(text) is
  'Lowercase, trim, and strip any plus tag so info+x@d.com and info@d.com
   compare equal. Does NOT strip dots: that is Gmail specific and would wrongly
   collapse distinct addresses elsewhere.';

-- Rebuild the view using the canonical comparison. Every other condition is
-- unchanged from 0006.
create or replace view public.outbound_sendable as
select
    o.id,
    o.id                as pid,
    o.client,
    o.channel,
    o.recipient         as "to",
    o.subject,
    o.body,
    o.tier,
    o.created_at,
    o.reviewed_at
from public.outbound o
join public.client_send_policy p
      on p.client = o.client
     and p.may_send is true
where o.status = 'approved'
  and o.direction = 'outbound'
  and o.channel = 'email'
  and o.recipient is not null
  and btrim(o.recipient) <> ''
  and o.recipient ~* '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$'
  and o.body is not null
  and btrim(o.body) <> ''
  and o.sent_at is null
  and public.canonical_email(o.recipient) not in (
        select public.canonical_email(s.email) from public.suppression s
      );

comment on view public.outbound_sendable is
  'Rows proven safe to send. Suppression is compared on canonical_email so plus
   tagged variants of a suppressed address cannot slip through.';

revoke all on public.outbound_sendable from anon, authenticated;
grant select on public.outbound_sendable to service_role;
