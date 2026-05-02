Supabase types and migration notes

- `src/lib/types/supabase.ts` contains the generated TypeScript definitions for your Supabase schema.
- This file was generated via the MCP tool; do NOT commit it without reviewing for sensitive schemas.

To regenerate locally (requires `supabase` CLI and your `SUPABASE_PROJECT_REF` env var):

```bash
export SUPABASE_PROJECT_REF=your-project-ref
npm run supabase:types
```

Migration safety notes

- The `supabase/migrations/20260502_auth_schema.sql` file was updated to be idempotent and defensive for existing DBs.
- I did NOT commit these DB changes to your remote project; they were applied via your Supabase MCP.
- If you prefer a different default for `users.id` (e.g., `auth.uid()`), handle `id` assignment at application insert time rather than in the migration.
