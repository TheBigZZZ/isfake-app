create table if not exists public.opencorporates_cache (
	cache_key text primary key,
	cache_type text not null,
	payload jsonb not null,
	status_code integer not null default 200,
	expires_at timestamptz not null,
	hit_count integer not null default 0,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create index if not exists opencorporates_cache_expires_at_idx
	on public.opencorporates_cache (expires_at);

create index if not exists opencorporates_cache_type_expires_at_idx
	on public.opencorporates_cache (cache_type, expires_at);

alter table public.opencorporates_cache enable row level security;

do $$
begin
	create policy "service role manages opencorporates cache"
		on public.opencorporates_cache
		for all
		using (auth.role() = 'service_role')
		with check (auth.role() = 'service_role');
exception
	when duplicate_object then null;
end $$;

create or replace function public.prune_opencorporates_cache()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
	deleted_count integer := 0;
begin
	delete from public.opencorporates_cache
	where expires_at < now();

	get diagnostics deleted_count = row_count;
	return deleted_count;
end;
$$;