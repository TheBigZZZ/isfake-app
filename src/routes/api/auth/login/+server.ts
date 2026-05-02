import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAdminSupabase } from '$lib/server/supabase';
import * as Sentry from '@sentry/sveltekit';
import { checkAuthLoginRateLimit, isAccountLocked, recordFailedLogin, resetFailedLogin } from '$lib/server/rate-limit';
import { z } from 'zod';
import { createServerLogger } from '$lib/server/logger';

// AuthRequest type removed in favor of Zod runtime validation

/**
 * POST /api/auth/login - Login an existing user
 * Body: { email, password }
 * Returns: { user: { id, email }, session: { access_token } } or error
 */
export const POST: RequestHandler = async ({ request }) => {
	if (request.method !== 'POST') {
		return json({ error: 'Method not allowed' }, { status: 405 });
	}

	try {
		const raw = await request.text().catch(() => '');
		let parsed: unknown = {};
		try {
			parsed = raw ? JSON.parse(raw) : {};
		} catch {
			return json({ error: 'Invalid JSON body' }, { status: 400 });
		}

		const loginSchema = z.object({
			email: z.string().email(),
			password: z.string().min(8)
		});

		const parsedRes = loginSchema.safeParse(parsed);
		if (!parsedRes.success) {
			const issues = parsedRes.error.errors;
			let msg = 'Invalid login data';
			const emailIssues = issues.filter(i => i.path && i.path[0] === 'email');
			const pwIssues = issues.filter(i => i.path && i.path[0] === 'password');
			if (emailIssues.length > 0) msg = 'Invalid email';
			else if (pwIssues.some(i => i.code === 'too_small')) msg = 'Password must be at least 8 characters';

			return json({ error: msg, details: parsedRes.error.flatten() }, { status: 400 });
		}

		const email = parsedRes.data.email.trim().toLowerCase();
		const password = parsedRes.data.password;

		// Check whether the account is currently locked due to failed attempts before any other auth gating.
		const lock = await isAccountLocked(email);
		if (lock.locked) {
			Sentry.captureMessage('Login attempt on locked account', { level: 'warning', tags: { context: 'auth_account_locked', attempts: String(lock.attempts), fallback: String(lock.fallback) } });
			return json({ error: 'Account locked due to multiple failed login attempts. Try again later.' }, { status: 423 });
		}

		// Rate limit by IP. If the login is already a valid credential attempt, count it toward
		// the account lock as well so repeated blocked attempts still trip the lockout path.
		const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('cf-connecting-ip') || 'unknown';
		const rl = await checkAuthLoginRateLimit(clientIp);
		if (!rl.allowed) {
			try {
				const lockState = await recordFailedLogin(email);
				if (lockState.locked) {
					Sentry.captureMessage('Login attempt triggered account lock', {
						level: 'warning',
						tags: { context: 'auth_account_locked', attempts: String(lockState.attempts), fallback: String(lockState.fallback) }
					});
					return json({ error: 'Account locked due to multiple failed login attempts. Try again later.' }, { status: 423 });
				}
			} catch {
				// ignore errors from the lock recorder
			}

			Sentry.captureMessage('Login rate limit exceeded', { level: 'warning', tags: { context: 'auth_rate_limit', ip: clientIp } });
			return json({ error: 'Too many login attempts. Try again later.' }, { status: 429 });
		}

		const adminSupabase = getAdminSupabase();

		// Sign in user via Supabase Auth
		const { data, error } = await adminSupabase.auth.signInWithPassword({
			email,
			password
		});

		if (error) {
			// Record the failed attempt for the account (email)
			try {
				const lockState = await recordFailedLogin(email);
				if (lockState.locked) {
					Sentry.captureMessage('Login attempt triggered account lock', {
						level: 'warning',
						tags: { context: 'auth_account_locked', attempts: String(lockState.attempts), fallback: String(lockState.fallback) }
					});
					return json({ error: 'Account locked due to multiple failed login attempts. Try again later.' }, { status: 423 });
				}
			} catch {
				// ignore errors from the lock recorder
			}
			Sentry.captureException(error, { tags: { context: 'auth_login' } });
			return json({ error: 'Invalid login credentials' }, { status: 401 });
		}

		if (!data.user || !data.session) {
			return json({ error: 'Login failed' }, { status: 500 });
		}

		// Successful login — reset failed attempt counter
		try {
			await resetFailedLogin(email);
		} catch {
			// ignore
		}

		return json(
			{
				user: {
					id: data.user.id,
					email: data.user.email
				},
				session: data.session
			},
			{ status: 200 }
		);
	} catch (error) {
		Sentry.captureException(error, { tags: { context: 'auth_login_exception' } });
		createServerLogger('api.auth.login').error('Auth login error', error);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};
