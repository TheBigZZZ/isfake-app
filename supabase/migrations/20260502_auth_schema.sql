-- Create users table
-- Ensure pgcrypto for gen_random_uuid
create extension if not exists pgcrypto;

create table if not exists public.users (
	id uuid not null default gen_random_uuid(),
	email text not null,
	plan text not null default 'free' check (plan in ('free', 'supporter')),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (id),
	constraint users_email_unique unique (email)
);

-- Create quotas table
create table if not exists public.quotas (
	id uuid not null default gen_random_uuid(),
	user_id uuid not null references public.users(id) on delete cascade,
	scans_used integer not null default 0,
	scans_limit integer not null default 10,
	plan text not null default 'free' check (plan in ('free', 'supporter')),
	reset_date date not null default current_date,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (id),
	constraint quotas_user_id_date_unique unique (user_id, reset_date)
);

-- Create scan_history table
create table if not exists public.scan_history (
	id uuid not null default gen_random_uuid(),
	user_id uuid not null references public.users(id) on delete cascade,
	barcode text not null,
	result jsonb not null,
	created_at timestamptz not null default now(),
	primary key (id)
);

alter table if exists public.scan_history add column if not exists created_at timestamptz default now();
do $$
begin
	if exists(
		select 1 from information_schema.columns
		where table_schema = 'public' and table_name = 'scan_history' and column_name = 'scanned_at'
	) then
		update public.scan_history set created_at = scanned_at where created_at is null;
	end if;
end $$;

-- Enable RLS on all tables
alter table public.users enable row level security;
alter table public.quotas enable row level security;
alter table public.scan_history enable row level security;

-- RLS policy for users: can only read own user record
do $$
begin
	create policy "users_can_read_own" on public.users
		for select
		using (auth.uid() = id);
exception
	when duplicate_object then null;
end $$;

-- RLS policy for quotas: can only read own quotas
do $$
begin
	create policy "quotas_can_read_own" on public.quotas
		for select
		using (auth.uid() = user_id);
exception
	when duplicate_object then null;
end $$;

do $$
begin
	create policy "quotas_service_role_update" on public.quotas
		for update
		using (auth.role() = 'service_role');
exception
	when duplicate_object then null;
end $$;

-- RLS policy for scan_history: can only read own history
do $$
begin
	create policy "scan_history_can_read_own" on public.scan_history
		for select
		using (auth.uid() = user_id);
exception
	when duplicate_object then null;
end $$;

drop policy if exists "Users can read own scan history" on public.scan_history;

do $$
begin
	create policy "scan_history_service_role_insert" on public.scan_history
		for insert
		with check (auth.role() = 'service_role');
exception
	when duplicate_object then null;
end $$;

-- Create indexes for performance
create index if not exists quotas_user_id_idx on public.quotas(user_id);
create index if not exists quotas_reset_date_idx on public.quotas(reset_date);
create index if not exists scan_history_user_id_idx on public.scan_history(user_id);
create index if not exists scan_history_created_at_idx on public.scan_history(created_at);
create index if not exists scan_history_barcode_idx on public.scan_history(barcode);

-- Create function to reset daily quotas
-- Create function to reset daily quotas
create or replace function public.reset_daily_quotas()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
	-- Reset scans_used for quotas with a past reset_date.
	-- Avoid referencing optional audit columns so this function is safe
	-- when applied against older or partial schemas.
	update public.quotas
	set scans_used = 0, reset_date = current_date
	where reset_date < current_date;
end;
$$;

-- Create function to enforce quotas
create or replace function public.check_user_quota(p_user_id uuid)
returns table(allowed boolean, scans_remaining integer, plan text)
language plpgsql
security definer
set search_path = public
as $$
declare
	v_scans_used integer;
	v_scans_limit integer;
	v_plan text;
begin
	select scans_used, scans_limit, quotas.plan
	into v_scans_used, v_scans_limit, v_plan
	from quotas
	where user_id = p_user_id and reset_date = current_date
	limit 1;

	if not found then
		insert into quotas (user_id, scans_used, scans_limit, plan, reset_date)
		select p_user_id, 0, (case when users.plan = 'supporter' then 100 else 10 end), users.plan, current_date
		from users where id = p_user_id;

		select scans_used, scans_limit, quotas.plan
		into v_scans_used, v_scans_limit, v_plan
		from quotas
		where user_id = p_user_id and reset_date = current_date
		limit 1;
	end if;

	return query select
		(v_scans_used < v_scans_limit)::boolean,
		(v_scans_limit - v_scans_used)::integer,
		v_plan;
end;
$$;

-- Create function to increment quota usage
create or replace function public.increment_quota_usage(p_user_id uuid)
returns table(allowed boolean, scans_remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
	r record;
	v_allowed boolean;
	v_scans_remaining integer;
begin
	select * into r from check_user_quota(p_user_id);
	v_allowed := r.allowed;
	v_scans_remaining := r.scans_remaining;

	if not v_allowed then
		return query select false, 0;
		return;
	end if;

	update quotas
	set scans_used = scans_used + 1
	where user_id = p_user_id and reset_date = current_date;

	v_scans_remaining := v_scans_remaining - 1;
	return query select true, v_scans_remaining;
end;
$$;

revoke execute on function public.check_user_quota(uuid) from public, anon, authenticated;
revoke execute on function public.increment_quota_usage(uuid) from public, anon, authenticated;
revoke execute on function public.reset_daily_quotas() from public, anon, authenticated;

grant execute on function public.check_user_quota(uuid) to service_role;
grant execute on function public.increment_quota_usage(uuid) to service_role;
grant execute on function public.reset_daily_quotas() to service_role;
