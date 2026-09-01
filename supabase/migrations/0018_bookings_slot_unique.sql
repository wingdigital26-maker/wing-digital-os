-- ═══════════════════════════════════════════════════════════════════════════
-- 0018_bookings_slot_unique.sql — close the double-booking race
--
-- /api/booking re-checks slot availability right before inserting, but two
-- requests landing in the same instant can both pass that check. This partial
-- unique index makes the database itself refuse the second insert; the route
-- surfaces the conflict as "that slot was just taken". Cancelled bookings are
-- excluded so a freed slot can be rebooked.
-- ═══════════════════════════════════════════════════════════════════════════

create unique index if not exists bookings_slot_unique
  on public.bookings (starts_at)
  where status <> 'cancelled';
