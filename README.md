# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.15.1 create --template minimal --types ts --add prettier eslint tailwindcss="plugins:typography,forms" sveltekit-adapter="adapter:auto" --install npm isfake-app
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## Environment Variables

Create a local `.env` file and fill in your Supabase, OpenRouter, verify API, and Upstash values.

Required server secrets for the scan API now include:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `SEARCH_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Optional server env flags:

- `SCAN_DEBUG_LOGS` (`true`/`false`, default `false`): enables verbose scan-route debug logs. Keep disabled in production.
- `AUTH_RATE_LIMIT_FAIL_CLOSED` (`true`/`false`): controls whether auth/scan rate limits reject requests when Upstash is unavailable. Defaults to `true` in production and `false` outside production.

The important one for the barcode scan error is `VITE_VERIFY_API_URL`. The app uses that URL for scan and vote requests instead of assuming a local SvelteKit server exists inside Capacitor.

Example:

```sh
VITE_VERIFY_API_URL=https://your-backend.example.com/api/verify
UPSTASH_REDIS_REST_URL=https://your-upstash-url.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-upstash-token
SCAN_DEBUG_LOGS=false
```

After changing any `VITE_` value, rebuild the app so the new env value is baked into the web bundle:

```sh
npm run build
npx cap sync android
```
