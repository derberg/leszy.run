-- Live status of a Raspberry-Pi checkpoint agent, one row per checkpoint,
-- upserted as a ~15s heartbeat by the agent (anon key). Display-only for the
-- admin checkpoints tab — same trust model as checkpoint_observations (anon
-- writable). No Drizzle schema / no local migration; the backend reads it via
-- service role.
create table if not exists checkpoint_agents (
  checkpoint_id  uuid primary key references checkpoints(id) on delete cascade,
  status         text not null,        -- 'configured' | 'armed_waiting' | 'listening'
  reads_total    integer not null default 0,
  queue_pending  integer not null default 0,
  unknown_count  integer not null default 0,
  last_seen_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table checkpoint_agents enable row level security;

create policy "anon read checkpoint_agents"   on checkpoint_agents for select to anon using (true);
create policy "anon insert checkpoint_agents" on checkpoint_agents for insert to anon with check (true);
create policy "anon update checkpoint_agents" on checkpoint_agents for update to anon using (true) with check (true);
