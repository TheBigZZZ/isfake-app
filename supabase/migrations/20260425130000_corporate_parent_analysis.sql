alter table public.products
	add column if not exists parent_company text,
	add column if not exists origin_country text,
	add column if not exists is_flagged boolean not null default false;

do $$
begin
	if exists (
		select 1
		from information_schema.columns
		where table_schema = 'public'
		  and table_name = 'products'
		  and column_name = 'name'
	) then
		update public.products
		set
			brand = coalesce(nullif(brand, ''), nullif(name, ''), 'UNKNOWN BRAND'),
			parent_company = coalesce(nullif(parent_company, ''), 'UNKNOWN PARENT'),
			origin_country = coalesce(nullif(origin_country, ''), 'UNKNOWN');
	else
		update public.products
		set
			brand = coalesce(nullif(brand, ''), 'UNKNOWN BRAND'),
			parent_company = coalesce(nullif(parent_company, ''), 'UNKNOWN PARENT'),
			origin_country = coalesce(nullif(origin_country, ''), 'UNKNOWN');
	end if;

	if exists (
		select 1
		from information_schema.columns
		where table_schema = 'public'
		  and table_name = 'products'
		  and column_name = 'is_israeli'
	) then
		update public.products
		set is_flagged = coalesce(is_flagged, is_israeli, false);
	else
		update public.products
		set is_flagged = coalesce(is_flagged, false);
	end if;
end $$;

alter table public.products
	alter column brand set default 'UNKNOWN BRAND',
	alter column parent_company set default 'UNKNOWN PARENT',
	alter column origin_country set default 'UNKNOWN',
	alter column is_flagged set default false,
	alter column brand set not null,
	alter column parent_company set not null,
	alter column origin_country set not null,
	alter column is_flagged set not null;

alter table public.products
	drop column if exists name,
	drop column if exists is_israeli,
	drop column if exists status,
	drop column if exists confidence,
	drop column if exists reasoning,
	drop column if exists context_text,
	drop column if exists verified_at;

drop table if exists public.pending_votes cascade;
drop function if exists public.increment_and_verify(text, boolean, text, text, text, text, text, numeric);

alter table public.products enable row level security;

do $$
begin
	create policy "service role manages corporate products"
		on public.products
		for all
		using (auth.role() = 'service_role')
		with check (auth.role() = 'service_role');
exception
	when duplicate_object then null;
end $$;
