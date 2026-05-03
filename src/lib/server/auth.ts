import { env } from '$env/dynamic/private';
import * as Sentry from '@sentry/sveltekit';
import { createServerLogger } from '$lib/server/logger';
import type { RequestEvent } from '@sveltejs/kit';
import jwt from 'jsonwebtoken';

const SUPABASE_JWT_SECRET = env.SUPABASE_JWT_SECRET;

export type AuthUser = {
	id: string;
	email: string;
	plan: 'free' | 'supporter';
	created_at: string;
};

/**
 * Extract and validate JWT from Authorization header
 */
export function extractJwtFromRequest(request: Request): string | null {
	const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');

	// Prefer Authorization header when present
	if (authHeader && authHeader.startsWith('Bearer ')) {
		// If a cookie token is also present, prefer header but log for telemetry
		const cookieHeader = request.headers.get('cookie') || request.headers.get('Cookie') || '';
		if (cookieHeader && cookieHeader.includes('sb-access-token')) {
			// Minimal logging; avoid leaking token contents
			createServerLogger('lib.auth').warn('Both Authorization header and sb-access-token cookie present; preferring Authorization');
		}
		return authHeader.slice(7).trim();
	}

	// Fallback: parse cookies header for sb-access-token
	const cookieHeader = request.headers.get('cookie') || request.headers.get('Cookie') || '';
	if (cookieHeader) {
		const cookies = Object.fromEntries(cookieHeader.split(';').map(s => {
			const [k, ...v] = s.split('=');
			return [k.trim(), decodeURIComponent((v || []).join('='))];
		}));
		if (cookies['sb-access-token']) return cookies['sb-access-token'];
	}

	return null;
}

/**
 * Verify JWT token (basic validation without crypto)
 * In production, use jsonwebtoken library for full verification
 */
export function verifyJwt(token: string): AuthUser | null {
	try {
		if (!SUPABASE_JWT_SECRET) {
			createServerLogger('lib.auth').error('SUPABASE_JWT_SECRET not configured', new Error('missing_jwt_secret'));
			return null;
		}

		// Verify signature and expiration using jsonwebtoken
		const payload = jwt.verify(token, SUPABASE_JWT_SECRET, {
			algorithms: ['HS256']
		}) as { sub: string; email: string; plan?: string; iat?: number };

		if (!payload || !payload.sub || !payload.email) {
			return null;
		}

		return {
			id: payload.sub,
			email: payload.email,
			plan: payload.plan === 'supporter' ? 'supporter' : 'free',
			created_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : new Date().toISOString()
		};
	} catch (err: unknown) {
		// jwt.verify throws JsonWebTokenError for invalid signature/expired tokens
		try {
			const error = err as Record<string, unknown>;
			if (error && typeof error === 'object' && 'name' in error && (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError')) {
				return null;
			}
		} catch {
			// Silently continue to capture exception below
		}

		Sentry.captureException(err, { tags: { context: 'jwt_verification' } });
		return null;
	}
}

/**
 * Extract user from request event
 */
export async function getUserFromEvent(event: RequestEvent): Promise<AuthUser | null> {
	if (event.locals.user) {
		return event.locals.user;
	}

	const token = extractJwtFromRequest(event.request);
	if (!token) {
		return null;
	}

	const user = verifyJwt(token);
	if (user) {
		event.locals.user = user;
	}
	return user;
}

/**
 * Require authentication on a route
 */
export async function requireAuth(event: RequestEvent): Promise<AuthUser> {
	const user = await getUserFromEvent(event);
	if (!user) {
		const error = new Error('Unauthorized: missing or invalid token');
		Sentry.captureException(error, { tags: { context: 'auth_required' } });
		throw error;
	}
	return user;
}
