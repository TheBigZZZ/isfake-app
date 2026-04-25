alter table public.products
	add column if not exists category text,
	add column if not exists parent_hq_country text,
	add column if not exists source_attribution text,
	add column if not exists arbitration_log text;

update public.products
set
	category = coalesce(nullif(category, ''), 'Unknown'),
	parent_hq_country = coalesce(nullif(parent_hq_country, ''), 'UNKNOWN'),
	source_attribution = coalesce(nullif(source_attribution, ''), 'Internal_Knowledge'),
	arbitration_log = coalesce(nullif(arbitration_log, ''), 'Cached result from Supabase.');
