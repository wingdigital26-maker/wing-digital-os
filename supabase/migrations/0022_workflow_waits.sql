-- ═══════════════════════════════════════════════════════════════════════════
-- 0022_workflow_waits.sql -- time-delayed steps for the automation engine.
--
-- WHY THIS EXISTS
-- 0021 runs every action of a workflow in one go. Real automations pause:
-- "text them 24 hours before the booking", "ask for a review a day after the
-- deal is won". A pause cannot live inside a serverless invocation, so the
-- run row itself has to remember where it stopped and when to carry on.
--
-- WHAT CHANGES
--   workflow_runs.resume_at   when the paused run is due to continue
--   workflow_runs.next_step   the step_order to continue FROM (the step after
--                             the wait), so the wait never re-runs
--   workflow_runs.context     what the run needs later: a snapshot of the
--                             event payload plus the contact id at pause time
--
-- STATUS VOCABULARY (workflow_runs.status is free text, no check constraint)
--   running | done | failed | skipped | waiting
--   'waiting' is new: the run is paused on a wait step. The cron's
--   resumeWaitingRuns() (lib/automations/engine.ts) picks it up once
--   resume_at has passed. A waiting run is NOT "stuck": failStuckRuns only
--   looks at status = 'running', so waits of any length survive it.
--
-- NULL means unknown. resume_at / next_step are NULL on every run that is not
-- waiting. context is an empty object until a wait stores something.
--
-- Idempotent: safe to re-run. Runs against the OS Supabase project.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.workflow_runs
    add column if not exists resume_at timestamptz,
    add column if not exists next_step int,
    add column if not exists context   jsonb not null default '{}'::jsonb;

-- The resume query is "status = waiting and resume_at <= now()", nothing else.
create index if not exists workflow_runs_waiting_idx
    on public.workflow_runs (resume_at)
    where status = 'waiting';
