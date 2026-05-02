Sentry integration notes

Environment variables
- `SENTRY_DSN` (required to enable Sentry): server DSN for sending events.
- `SENTRY_RELEASE` (optional but recommended): a release identifier (e.g. `my-app@1.2.3` or CI commit SHA).
- `SENTRY_TRACES_SAMPLE_RATE` (optional): float between 0 and 1 controlling performance sampling (e.g. `0.1`).

Runtime behavior
- When `SENTRY_DSN` is set the server initializes Sentry on startup.
- Each incoming request starts a Sentry transaction and sets `x-request-id` on the response.
- Uncaught errors are captured to Sentry with request context via `handleError`.
- The application logger forwards errors/warnings/info to Sentry when `SENTRY_DSN` is present.

Uploading sourcemaps / releases
1. Install `sentry-cli` (see https://docs.sentry.io/cli/).
2. Create a release (use the exact `SENTRY_RELEASE` value used at runtime):
   ```bash
   sentry-cli releases new "$SENTRY_RELEASE"
   ```
3. Upload sourcemaps and artifacts (adjust paths to your build outputs):
   ```bash
   sentry-cli releases files "$SENTRY_RELEASE" upload-sourcemaps ./build --url-prefix "~/" --validate
   ```
4. Finalize the release:
   ```bash
   sentry-cli releases finalize "$SENTRY_RELEASE"
   ```
5. In CI, set `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` as required by `sentry-cli`.

Recommended settings
- `SENTRY_TRACES_SAMPLE_RATE`: start small (e.g. `0.05`–`0.1`) in production to limit volume.
- Use a deterministic `SENTRY_RELEASE` (CI commit SHA or version) to map errors to releases and upload sourcemaps correctly.
- Use separate Sentry projects/environments for `production`, `staging`, and `development`.
- Avoid sending PII unless you explicitly need it; prefer adding contextual tags/extra instead of raw user data.
- Enable source map upload during your CI build step so stack traces are symbolicated in Sentry.

Troubleshooting
- If events don't appear, verify `SENTRY_DSN` and network egress from your runtime.
- Confirm the release you used to upload sourcemaps exactly matches `SENTRY_RELEASE`.
- Use `SENTRY_TRACES_SAMPLE_RATE=0` to disable performance tracing if it's causing too many events.
