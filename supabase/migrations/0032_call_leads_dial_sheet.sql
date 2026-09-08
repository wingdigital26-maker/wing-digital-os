-- 0032_call_leads_dial_sheet.sql
-- Carry the dial-sheet intel into the call room.
--
-- The standalone HTML dial sheets (wing-dial-sheet) show a caller far more per
-- lead than /calls did: the angle he reads before the call connects, evidence
-- chips, socials with real handles, and the "check before you dial" cautions
-- that stop him repeating something we could not confirm. These columns give
-- the room somewhere to keep all of that.
--
-- Every column is nullable and additive. Existing rows, the existing importers
-- and every working-state column (status, claim, call_count, notes) are
-- untouched: a lead with no enriched data simply keeps nulls and the UI hides
-- the sections rather than showing empty scaffolding.

alter table public.call_leads
  add column if not exists angle          text,       -- two sentences: this company's specific gap
  add column if not exists cautions       jsonb,      -- ["...", "..."] shown as "Check before you dial"
  add column if not exists chips          jsonb,      -- [{"label":"no blog","tone":"miss"}, ...]
  add column if not exists socials        jsonb,      -- [{"platform":"Instagram","handle":"x","url":"..."}]
  add column if not exists google_reviews integer,
  add column if not exists google_rating  numeric,
  add column if not exists site_pages     integer,
  add column if not exists has_blog       boolean,
  add column if not exists service_pages  integer;

comment on column public.call_leads.angle is
  'The one thing the caller says on the call. Two sentences naming this company''s specific gap.';
comment on column public.call_leads.cautions is
  'JSON array of strings. Facts we could NOT confirm. Rendered as a warning block above the phone button so a caller never repeats something wrong on a live call.';
comment on column public.call_leads.chips is
  'JSON array of {label, tone} where tone is has | miss | neutral. Evidence chips: page count, blog, service pages, reviews, SSL, socials.';
comment on column public.call_leads.socials is
  'JSON array of {platform, handle, url}. Only accounts we could confirm; anything name-matched only belongs in cautions instead.';
