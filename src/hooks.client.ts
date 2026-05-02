import * as Sentry from '@sentry/sveltekit';

const dsn = import.meta.env.VITE_SENTRY_DSN;

if (dsn) {
	Sentry.init({
		dsn,
		environment: import.meta.env.MODE,
		tracesSampleRate: 0,
		integrations: [Sentry.consoleIntegration()],
		sendDefaultPii: false
	});
}

export const init = () => {};

export const handleError = Sentry.handleErrorWithSentry(({ error, event }: { error: unknown; event: unknown }) => {
	console.error('An error occurred on the client side:', error, event);
});