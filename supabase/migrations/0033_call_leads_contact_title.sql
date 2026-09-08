-- 0033_call_leads_contact_title.sql
-- Who the named contact actually is at the company.
--
-- The room now shows "Ask for Daniel Mitchell" as the loudest line on the
-- card. Knowing he is the Owner rather than an estimator changes how the
-- caller opens, and the owner-name pass already reads that title off the
-- same About page it takes the name from. Nullable and additive: a lead with
-- a name but no title just shows the name.

alter table public.call_leads
  add column if not exists contact_title text;

comment on column public.call_leads.contact_title is
  'Role of contact_name at this company (Owner, President, GM). Read off the same source as the name; null when the source did not state one.';
