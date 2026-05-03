import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { getAdminSupabase } from '$lib/server/supabase';
import * as Sentry from '@sentry/node';
import { createServerLogger } from '$lib/server/logger';

type RefreshRequest = {
	refresh_token?: string;
};

/**
 * POST /api/auth/refresh - Refresh an access token using a refresh token
 * Body: { refresh_token } (or can be sent via Authorization header)
 * Returns: { session: { access_token, refresh_token } } or error
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	if (request.method !== 'POST') {
		return json({ error: 'Method not allowed' }, { status: 405 });
	}

	try {
		const body = (await request.json()) as RefreshRequest;
		let refreshToken = body.refresh_token;

		// Try to get refresh token from cookies if not in body
		if (!refreshToken) {
			refreshToken = cookies.get('sb-refresh-token');
		}

		if (!refreshToken || typeof refreshToken !== 'string') {
			return json({ error: 'Refresh token is required' }, { status: 400 });
		}

		const adminSupabase = getAdminSupabase();

		// Use the refresh token to get a new session
		const { data, error } = await adminSupabase.auth.refreshSession({
			refresh_token: refreshToken
		});

		if (error || !data.session) {
			Sentry.captureException(error || new Error('Session refresh failed'), {
				tags: { context: 'auth_refresh' }
			});

			// Clear any existing auth cookies to avoid replay of stale tokens
			try {
				cookies.set('sb-access-token', '', { path: '/', httpOnly: true, secure: !dev, sameSite: 'strict', maxAge: 0 });
				cookies.set('sb-refresh-token', '', { path: '/', httpOnly: true, secure: !dev, sameSite: 'strict', maxAge: 0 });
			} catch {
				// ignore cookie clear errors
			}

			return json({ error: error?.message || 'Session refresh failed' }, { status: 401 });
		}

		// Set the new session in cookies for client-side persistence
		if (data.session.access_token) {
			cookies.set('sb-access-token', data.session.access_token, {
				path: '/',
				secure: !dev,
				httpOnly: true,
				sameSite: 'strict',
				maxAge: data.session.expires_in || 3600 // 1 hour default
			});

		}

		if (data.session.refresh_token) {
			// Prefer rotating refresh token; overwrite previous one
			cookies.set('sb-refresh-token', data.session.refresh_token, {
				path: '/',
				secure: !dev,
				httpOnly: true,
				sameSite: 'strict',
				maxAge: 604800 // 7 days
			});
		}

		return json(
			{
				session: {
					access_token: data.session.access_token,
					refresh_token: data.session.refresh_token,
					expires_in: data.session.expires_in,
					token_type: data.session.token_type
				}
			},
			{ status: 200 }
		);
	} catch (error) {
		Sentry.captureException(error, { tags: { context: 'auth_refresh_exception' } });
		createServerLogger('api.auth.refresh').error('Auth refresh error', error);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};
