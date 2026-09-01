-- ═══════════════════════════════════════════════════════════════════════════
-- 0019_caller_team.sql — second caller (Maddox) team plumbing
--
-- Two small additive changes for the 2026-09-01 Maddox onboarding:
--
--   1. call_leads.assigned_to / assigned_to_email — lead OWNERSHIP, distinct
--      from the 20-minute soft claim. Maddox's imported dial sheet is
--      assigned to Maddox; the room stays shared (everyone still sees every
--      lead) but the list can now filter "Maddox's sheet" and Jack/Grant can
--      watch a caller's book without a text.
--
--   2. calendar_blocks.person — turns Jack's single calendar into the trio
--      calendar. 'jack' | 'grant' | 'maddox' | 'team'. Existing rows default
--      to 'jack'. Text, not an enum, so a fourth person is a row, not a
--      migration. The shared /calls/schedule view renders one lane per
--      person; booked calls overlay from call_leads and bookings.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.call_leads
  add column if not exists assigned_to uuid references auth.users (id),
  add column if not exists assigned_to_email text;

create index if not exists call_leads_assigned_idx
  on public.call_leads (assigned_to);

alter table public.calendar_blocks
  add column if not exists person text not null default 'jack';

create index if not exists calendar_blocks_person_idx
  on public.calendar_blocks (person);
