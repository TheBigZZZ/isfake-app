-- Enable pg_cron extension (Supabase usually has this enabled)
create extension if not exists pg_cron;

-- Schedule daily quota reset at 00:00 UTC
select cron.schedule('reset-daily-quotas', '0 0 * * *', 'select public.reset_daily_quotas()');

-- Schedule OpenCorporates cache pruning daily at 02:00 UTC
select cron.schedule(
	'prune-opencorporates-cache',
	'0 2 * * *',
	'select public.prune_opencorporates_cache()'
);

-- Schedule scan history archival weekly (keep only 90 days)
-- This is a placeholder - in production you'd implement archival to a separate table
select cron.schedule(
	'archive-old-scan-history',
	'0 3 * * 0', -- Weekly on Sunday at 03:00 UTC
	'delete from public.scan_history where created_at < now() - interval ''90 days'''
);

revoke execute on function public.prune_opencorporates_cache() from public, anon, authenticated;
grant execute on function public.prune_opencorporates_cache() to service_role;

-- Create audit log table for tracking quota resets and other important events
create table if not exists public.audit_log (
	id uuid not null default gen_random_uuid(),
	event_type text not null,
	user_id uuid,
	details jsonb,
	created_at timestamptz not null default now(),
	primary key (id)
);

create index if not exists audit_log_user_id_idx on public.audit_log(user_id);
create index if not exists audit_log_created_at_idx on public.audit_log(created_at);

-- Enable RLS on audit log
alter table public.audit_log enable row level security;

do $$
begin
	create policy "audit_log_service_role_only" on public.audit_log
		for all
		using (auth.role() = 'service_role');
exception
	when duplicate_object then null;
end $$;
