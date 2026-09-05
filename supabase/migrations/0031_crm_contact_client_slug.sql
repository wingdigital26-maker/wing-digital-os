-- ═══════════════════════════════════════════════════════════════════════════
-- 0031_crm_contact_client_slug.sql -- tag a CRM contact to a specific client.
--
-- Until now crm_contacts held Wing's own outreach prospects, with no notion of
-- "this contact belongs to client X's customer list". To send review requests,
-- texts and emails to a CLIENT's past customers, we need to know whose list a
-- contact is on. This adds that tag.
--
--   client_slug NULL  -> a Wing prospect (the existing rows), not a client's
--                        customer. Unchanged behaviour.
--   client_slug set   -> this contact is on that client's customer list
--                        (imported from their past-customer list, or captured
--                        by that client's web form).
--
-- Additive and idempotent: existing rows keep client_slug NULL.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.crm_contacts
  add column if not exists client_slug text;

create index if not exists crm_contacts_client_slug_idx
  on public.crm_contacts (client_slug)
  where client_slug is not null;
