import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getAdminSupabase } from '$lib/server/supabase';
import { verifyJwt } from '$lib/server/auth';
import * as Sentry from '@sentry/sveltekit';
import { createServerLogger } from '$lib/server/logger';

function parseBoundedInt(value: string | null, fallback: number, min: number, max: number) {
	const parsed = Number.parseInt(value ?? '', 10);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	return Math.min(max, Math.max(min, parsed));
}

/**
 * GET /api/history - Get user's scan history
 * Requires: Authorization: Bearer <jwt_token>
 * Query params: limit=10, offset=0
 * Returns: { scans: [...], total: number, limit, offset }
 */
export const GET: RequestHandler = async ({ request, url }) => {
	try {
		// Extract JWT from Authorization header
		const authHeader = request.headers.get('Authorization') || '';
		if (!authHeader.startsWith('Bearer ')) {
			return json({ error: 'Unauthorized: missing token' }, { status: 401 });
		}

		const token = authHeader.slice(7).trim();
		const user = verifyJwt(token);

		if (!user) {
			return json({ error: 'Unauthorized: invalid token' }, { status: 401 });
		}

		const limit = parseBoundedInt(url.searchParams.get('limit'), 10, 1, 100);
		const offset = parseBoundedInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

		const adminSupabase = getAdminSupabase();

		// Get scan history with count
		const historyQuery = adminSupabase
			.from('scan_history')
			.select('id, barcode, result, created_at', { count: 'exact' })
			.eq('user_id', user.id)
			.order('created_at', { ascending: false })
			.range(offset, offset + limit - 1);

		const { data: scans, error: scanError, count } = (await historyQuery) as unknown as {
			data: Array<Record<string, unknown>> | null;
			error: unknown;
			count: number | null;
		};

		if (scanError) {
			Sentry.captureException(scanError, { tags: { context: 'history_fetch' } });
			return json({ error: 'Failed to fetch history' }, { status: 500 });
		}

		return json(
			{
				scans: scans || [],
				total: count || 0,
				limit,
				offset
			},
			{ status: 200 }
		);
	} catch (error) {
		Sentry.captureException(error, { tags: { context: 'history_exception' } });
		createServerLogger('api.history').error('History fetch error', error);
		return json({ error: 'Internal server error' }, { status: 500 });
	}
};
