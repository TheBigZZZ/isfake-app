import type { Handle, HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { env } from '$env/dynamic/private';
import { getRequestId } from '$lib/server/env';
import * as Sentry from '@sentry/node';

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

	// Security headers
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-XSS-Protection', '1; mode=block');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'accelerometer=(), camera=(), microphone=(), geolocation=(), magnetometer=(), payment=(), usb=()');

	// Strict-Transport-Security (HSTS) — enable in production
	if (env.NODE_ENV === 'production') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
	}

	// Content Security Policy (permissive for Capacitor/mobile compatibility)
	const csp = [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline' 'unsafe-eval' capacitor://", // unsafe-eval needed for Svelte
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
		"font-src 'self' https://fonts.gstatic.com data:",
		"img-src 'self' data: https:",
		"connect-src 'self' https://accounts.google.com https://*.supabase.co wss://*.supabase.co https://*.openrouter.ai https://*.upstash.io https://sentry.io",
		"frame-src 'self' https://accounts.google.com",
		"media-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'"
	].join('; ');
	response.headers.set('Content-Security-Policy', csp);

	return response;
};

export const handle = sequence(requestIdHandle);

export const handleError: HandleServerError = ({ error }) => {
	try {
		Sentry.captureException(error);
	} catch {
		// swallow Sentry errors
	}
	return { message: 'Internal Server Error' };
};
