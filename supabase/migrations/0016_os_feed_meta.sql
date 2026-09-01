-- Agent run metadata on the notify feed. /api/notify now accepts an optional
-- files_changed count (and a short list of file paths/URLs) from agent runs;
-- both land here as jsonb so the Agents tab can show "12 files updated".
-- Honest states: rows without a reported count simply have meta null — the UI
-- renders nothing for them, never 0.

alter table os_feed add column if not exists meta jsonb;
