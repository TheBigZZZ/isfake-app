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

Create a local `.env` file from `.env.example` and fill in your Supabase, OpenRouter, and verify API values.

The important one for the barcode scan error is `VITE_VERIFY_API_URL`. The app uses that URL for scan and vote requests instead of assuming a local SvelteKit server exists inside Capacitor.

Example:

```sh
VITE_VERIFY_API_URL=https://your-backend.example.com/api/verify
```

After changing any `VITE_` value, rebuild the app so the new env value is baked into the web bundle:

```sh
npm run build
npx cap sync android
```
