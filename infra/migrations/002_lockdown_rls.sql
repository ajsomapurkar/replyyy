-- Supabase exposes the public schema through its Data API (PostgREST) to the anon/authenticated roles.
-- Relay never uses that API: all access goes through the Node API, which connects as the table owner
-- (owners bypass RLS). Enabling RLS with NO policies therefore denies every Data API request — including
-- reads of session tokens and rider locations — while leaving the app untouched. Harmless on plain Postgres.
do $$
declare t text;
begin
  foreach t in array array['users','sessions','zones','vehicles','drivers','driver_locations','pool_groups','pool_members','rides',
    'ride_events','dispatch_offers','dispatch_decisions','zone_demand_buckets','zone_pricing_state','reposition_recommendations',
    'fleet_snapshots','idempotency_records','outbox_events','jobs','audit_log','demo_places']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
  end if;
end $$;
