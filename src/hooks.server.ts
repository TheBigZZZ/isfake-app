import type { Handle, HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { env } from '$env/dynamic/private';
import { getRequestId } from '$lib/server/env';
import * as Sentry from '@sentry/sveltekit';

if (env.SENTRY_DSN) {
	Sentry.init({
		dsn: env.SENTRY_DSN,
		release: env.SENTRY_RELEASE || undefined,
		environment: env.NODE_ENV || 'development',
		tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
		beforeSend(event) {
			if (event.request?.headers) {
				for (const headerName of [
					'authorization',
					'cookie',
					'set-cookie',
					'x-api-key',
					'apikey',
					'sb-access-token',
					'sb-refresh-token'
				]) {
					if (headerName in event.request.headers) {
						(event.request.headers as Record<string, string>)[headerName] = '[Filtered]';
					}
				}
			}

			if (event.exception) {
				const error = event.exception.values?.[0];
				if (error?.value?.includes?.('Rate limit')) return null;
			}
			return event;
		}
	});
}

const requestIdHandle: Handle = async ({ event, resolve }) => {
	const requestId = getRequestId(event.request);
	event.locals.requestId = requestId;
	event.locals.user = null;

	const response = await resolve(event, {
		filterSerializedResponseHeaders(name) {
			return name === 'content-type' || name === 'cache-control';
		}
	});

	response.headers.set('x-request-id', requestId);
	return response;
};

export const handle = sequence(Sentry.sentryHandle(), requestIdHandle);

export const handleError: HandleServerError = Sentry.handleErrorWithSentry(() => {
	return { message: 'Internal Server Error' };
});