import { env } from '$env/dynamic/private';
import * as Sentry from '@sentry/sveltekit';

if (env.SENTRY_DSN) {
	Sentry.init({
		dsn: env.SENTRY_DSN,
		release: env.SENTRY_RELEASE || undefined,
		environment: env.NODE_ENV || 'development',
		tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
		beforeSend(event) {
			if (event.exception) {
				const error = event.exception.values?.[0];
				if (error?.value?.includes?.('Rate limit')) return null;
			}
			return event;
		}
	});
}