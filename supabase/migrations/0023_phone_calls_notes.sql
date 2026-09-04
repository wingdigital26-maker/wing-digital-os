-- 0023: a free-text note on phone_calls.
--
-- WHY: /api/voice/inbound now tells a database outage apart from an
-- unregistered number. Both leave a status='failed' row, and the outage one
-- needs to say what failed so the ledger is evidence, not a guess.
-- NULL means no note. Idempotent.
alter table public.phone_calls add column if not exists notes text;
