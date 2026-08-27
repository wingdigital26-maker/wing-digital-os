-- Applied live to the Sonar project (klzmpjregrcxumaxfsug).
--
-- The send-result write-back (POST /api/outbound/sent) records why a send failed
-- so a transient failure can be retried and a hard bounce can be traced. Neither
-- column existed, so those writes were failing with PGRST204 and the outcome was
-- being reported as a per-row error instead of persisting.
--
-- These are deliberately SEPARATE from sent_at. sent_at means delivered, and it
-- is what removes a row from outbound_sendable. An attempt is not a delivery, so
-- a failed try must never touch it.

alter table public.outbound add column if not exists last_send_error text;
alter table public.outbound add column if not exists last_send_attempt_at timestamptz;

comment on column public.outbound.last_send_error is
  'Why the most recent send attempt failed. Null means no attempt has failed,
   NOT that a send succeeded.';

comment on column public.outbound.last_send_attempt_at is
  'When the sender last tried this row. Distinct from sent_at, which is set only
   on a real delivery.';
