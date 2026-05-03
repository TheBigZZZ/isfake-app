import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAdminSupabase } from '$lib/server/supabase';
import * as Sentry from '@sentry/sveltekit';
import { checkAuthSignupRateLimit } from '$lib/server/rate-limit';
import { createServerLogger } from '$lib/server/logger';
import { z } from 'zod';

// AuthRequest type removed in favor of Zod runtime validation

const PASSWORD_POLICY = {
	minLength: 10,
	minLowercase: 1,
	minUppercase: 1,
	minNumbers: 1,
	minSymbols: 1
} as const;

/**
 * POST /api/auth/signup - Register a new user
 * Body: { email, password }
 * Returns: { user: { id, email }, session: { access_token } } or error
 */
export const POST: RequestHandler = async ({ request }) => {
	if (request.method !== 'POST') {
		return json({ error: 'Method not allowed' }, { status: 405 });
	}

	try {
		// Rate limit by IP
		const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('cf-connecting-ip') || 'unknown';
		const rl = await checkAuthSignupRateLimit(clientIp);
		if (!rl.allowed) {
			Sentry.captureMessage('Signup rate limit exceeded', { level: 'warning', tags: { context: 'auth_rate_limit', ip: clientIp } });
			return json({ error: 'Too many signup attempts. Try again later.' }, { status: 429 });
		}

		const raw = await request.text().catch(() => '');
		let parsed: unknown = {};
		try {
			parsed = raw ? JSON.parse(raw) : {};
		} catch {
			return json({ error: 'Invalid JSON body' }, { status: 400 });
		}

		const signupSchema = z.object({
			email: z.string().email(),
			password: z.string().min(PASSWORD_POLICY.minLength).refine((p: string) => /[a-z]/.test(p), 'must include lowercase').refine((p: string) => /[A-Z]/.test(p), 'must include uppercase').refine((p: string) => /\d/.test(p), 'must include number').refine((p: string) => /[^A-Za-z0-9]/.test(p), 'must include symbol')
		});

		const result = signupSchema.safeParse(parsed);
		if (!result.success) {
			const issues = result.error.errors;
			// Build legacy-friendly error message fragments for smoke-tests
			let msg = 'Invalid signup data';
			const pwIssues = issues.filter(i => i.path && i.path[0] === 'password');
			if (pwIssues.some(i => i.code === 'too_small' || String(i.message).includes('min'))) msg = 'Password must be at least 10 characters and include upper, lower, number, and symbol characters';
			else if (pwIssues.some(i => String(i.message).toLowerCase().includes('uppercase') || String(i.message).toLowerCase().includes('upper'))) msg = 'Password must include upper';
			else if (pwIssues.some(i => String(i.message).toLowerCase().includes('number'))) msg = 'Password must include number';
			else if (pwIssues.some(i => String(i.message).toLowerCase().includes('symbol'))) msg = 'Password must include symbol';

			return json({ error: msg, details: result.error.flatten() }, { status: 400 });
		}

		const email = result.data.email.trim().toLowerCase();
		const password = result.data.password;

		const adminSupabase = getAdminSupabase();

		// Create the user directly from the server to avoid Supabase email confirmation throttles.
		const { data: createdUser, error: createError } = await adminSupabase.auth.admin.createUser({
			email,
			password,
			email_confirm: true
		});

		if (createError) {
			Sentry.captureException(createError, { tags: { context: 'auth_signup' } });
			return json({ error: 'Unable to create account' }, { status: 400 });
		}

		if (!createdUser.user) {
			return json({ error: 'User creation failed' }, { status: 500 });
		}

		// Sign the new user in immediately so the client gets a session back.
		const { data: loginData, error: loginError } = await adminSupabase.auth.signInWithPassword({
			email,
			password
		});

		if (loginError) {
			Sentry.captureException(loginError, { tags: { context: 'auth_signup_login' } });
			return json({ error: 'Unable to start session' }, { status: 500 });
		}

		// Create user record in public.users table (will have proper types once migrations applied)
		try {
			const usersTable = adminSupabase.from('users') as unknown as {
				insert: (rows: Array<Record<string, unknown>>) => Promise<unknown>;
			};
			await usersTable.insert([
				{
					id: createdUser.user.id,
					email: email,
					plan: 'free'
				}
			]);
		} catch (insertErr) {
			createServerLogger('api.auth.signup').warn('Failed to insert user record', { details: { error: String(insertErr) } });
		}

		// Create initial quota record for today
		try {
			const quotasTable = adminSupabase.from('quotas') as unknown as {
				insert: (rows: Array<Record<string, unknown>>) => Promise<unknown>;
			};
			await quotasTable.insert([
				{
					user_id: createdUser.user.id,
					scans_used: 0,
					scans_limit: 10,
					plan: 'free',
					reset_date: new Date().toISOString().split('T')[0]
				}
			]);
		} catch (quotaErr) {
			createServerLogger('api.auth.signup').warn('Failed to insert quota record', { details: { error: String(quotaErr) } });
		}

		return json(
			{
				user: {
					id: createdUser.user.id,
					email: createdUser.user.email
				},
				session: loginData.session
			},
			{ status: 200 }
		);
	} catch (error) {
		Sentry.captureException(error, { tags: { context: 'auth_signup_exception' } });
		createServerLogger('api.auth.signup').error('Auth signup error', error);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};
