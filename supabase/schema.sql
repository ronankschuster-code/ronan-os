-- Ronan OS — task layer.
-- Google Calendar holds anything time-bound. This holds everything else.
-- If this database vanishes, your calendar still works perfectly. That is the point.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- TASKS + INBOX
-- A task with no due_at and triaged=false is an Inbox item.
-- ---------------------------------------------------------------------------
create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  notes        text,
  bucket       text not null default 'inbox',   -- inbox | school | pulseboard | lxa | errand | personal
  due_at       timestamptz,                     -- soft due date; no time block reserved
  triaged      boolean not null default false,  -- false = still sitting in Inbox
  done         boolean not null default false,
  done_at      timestamptz,
  created_at   timestamptz not null default now(),
  -- when a task got promoted into a real calendar block, we remember which one
  gcal_event_id text
);

create index if not exists tasks_open_idx on tasks (done, triaged, due_at);

-- ---------------------------------------------------------------------------
-- BLOCK RUNS
-- One row per calendar work-block occurrence we care about following up on.
-- The evening sweep asks about anything here with status 'pending'.
-- ---------------------------------------------------------------------------
create table if not exists block_runs (
  id             uuid primary key default gen_random_uuid(),
  gcal_event_id  text not null,
  title          text not null,
  scheduled_for  timestamptz not null,
  status         text not null default 'pending',  -- pending | done | moved | skipped
  moved_to       timestamptz,
  slip_count     int not null default 0,           -- how many times this has been pushed
  asked_at       timestamptz,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (gcal_event_id, scheduled_for)
);

create index if not exists block_runs_pending_idx on block_runs (status, scheduled_for);

-- ---------------------------------------------------------------------------
-- SENT LOG
-- Dedupe guard. The cron ticks every 5 minutes; this stops double-sends.
-- ---------------------------------------------------------------------------
create table if not exists sent_log (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,        -- morning_brief | block_nudge | evening_sweep | deadline_warn
  ref        text not null,        -- event id, or a date string for daily things
  sent_at    timestamptz not null default now(),
  unique (kind, ref)
);

-- ---------------------------------------------------------------------------
-- PENDING REPLIES
-- When the bot asks a question, it parks the context here so the next
-- message you send can be interpreted as an answer rather than a new command.
-- ---------------------------------------------------------------------------
create table if not exists pending_replies (
  id          uuid primary key default gen_random_uuid(),
  chat_id     text not null,
  kind        text not null,        -- evening_sweep | triage | confirm_delete
  payload     jsonb not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists pending_replies_chat_idx on pending_replies (chat_id, expires_at);

-- ---------------------------------------------------------------------------
-- SETTINGS — single row, id = 1
-- ---------------------------------------------------------------------------
create table if not exists settings (
  id                    int primary key default 1,
  timezone              text not null default 'America/New_York',
  brief_lead_minutes    int  not null default 90,
  brief_earliest_hhmm   text not null default '06:30',  -- the floor. change if you want.
  evening_sweep_hhmm    text not null default '21:00',
  nudge_enabled         boolean not null default true,
  quiet_until           timestamptz,                     -- bot shuts up until this time
  constraint settings_singleton check (id = 1)
);

insert into settings (id) values (1) on conflict (id) do nothing;
