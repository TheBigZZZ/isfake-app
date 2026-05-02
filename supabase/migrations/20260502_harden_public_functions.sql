-- 2026-05-02: Harden public helper functions (mirror live MCP changes)
-- Purpose: Enforce least-privilege for helper functions used by server-side RPCs.

DO $$
DECLARE
  r record;
  fn_names text[] := ARRAY['check_user_quota','increment_quota_usage','reset_daily_quotas','prune_opencorporates_cache'];
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = ANY(fn_names)
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon, authenticated, public', r.proname, r.args);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'REVOKE failed for %: %', r.proname, SQLERRM;
    END;

    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO service_role', r.proname, r.args);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'GRANT failed for %: %', r.proname, SQLERRM;
    END;
  END LOOP;
END$$;

-- Attempt to remove any known duplicate scan_history SELECT policies by name
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'scan_history_select_duplicate' AND polrelid = 'public.scan_history'::regclass) THEN
    EXECUTE 'DROP POLICY scan_history_select_duplicate ON public.scan_history';
  END IF;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'Unable to drop duplicate scan_history policy: %', SQLERRM;
END$$;
