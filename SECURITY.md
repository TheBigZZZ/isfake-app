# Security Notes and Remediation Plan

Overview
------
This document summarizes immediate security findings and recommended next steps after an automated `npm audit` and code review of the auth and API stacks.

Findings
------
- `npm audit` reported 6 low-severity transitive vulnerabilities linked to `cookie` via `@sveltejs/kit`.
- The recommended fix is a SvelteKit upgrade (`@sveltejs/kit@0.0.30`) which is a breaking change and must be validated in its own branch.

Immediate Remediation Plan
------
1. Short-term: pin current dependencies and monitor; no high/critical issues found. Create a test branch for the SvelteKit upgrade.
2. Medium-term: prepare and test `@sveltejs/kit` upgrade on a branch, run full test-suite and smoke-tests, and validate third-party integrations (Supabase, Sentry, Upstash).
3. Long-term: add CI job that runs `npm audit` and fails on moderate/high/critical findings.

Auth & API Hardening (completed/in-progress)
------
- Enforced strict JSON content type and body size limit on `src/routes/api/scan/+server.ts` POST handler.
- Confirmed auth smoke-tests pass consistently on port 5179 (27/27).
- Mirrored live Supabase hardening in migrations: revoked direct `EXECUTE` on the quota and cache SECURITY DEFINER helpers from `anon`, `authenticated`, and `public`, then granted them only to `service_role`.
- Removed the duplicate `scan_history` self-read policy so the repo matches the live RLS policy set.
- Sanitized scan-route logging by routing raw debug output through a gated logger (`SCAN_DEBUG_LOGS`) with truncation/redaction for object payloads.
- Tightened rate-limit fallback behavior: auth/scan limiters now default to fail-closed in production (`AUTH_RATE_LIMIT_FAIL_CLOSED=true` unless explicitly overridden).
- Expanded server-side Sentry header filtering for token-style headers (`apikey`, `sb-access-token`, `sb-refresh-token`).
- Validation after changes: `npm run check` passed, smoke tests passed (27/27), and perf profile remained healthy (`/api/health` avg ~6.4ms, `/api/scan` avg ~32.3ms at concurrency 4).

Environment & Secrets
------
- Ensure `SUPABASE_JWT_SECRET`, Supabase service role key, and Upstash credentials are stored in a secure secrets manager or protected environment variables. Do not store them in plaintext or in the repository.
- Supabase advisor follow-up: leaked-password protection is currently disabled in the project settings and should be enabled in the dashboard.
- Supabase advisor follow-up: `pg_net` and `http` are installed in the `public` schema; move them out of `public` if the project does not rely on that placement.
- Supabase managed-extension note: `public.http*` routine ACLs are owned by `supabase_admin` and currently include explicit `anon`/`authenticated` execute grants. Direct revoke attempts from this environment were accepted but did not persist in effective privileges. Treat this as a platform-managed hardening item and resolve with Supabase dashboard/support guidance.

Pending External Follow-up
------
- Supabase support ticket opened for managed extension hardening guidance (`http`/`pg_net` in `public`, ACL behavior under `supabase_admin`).
- Until Supabase guidance is received, treat extension-in-public findings as externally blocked remediation.

Contact & Reporting
------
If you want, I can open a branch and apply the SvelteKit upgrade, run tests, and prepare a PR with a compatibility summary.
