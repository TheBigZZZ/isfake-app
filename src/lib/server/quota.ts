import { getAdminSupabase } from '$lib/server/supabase';
import * as Sentry from '@sentry/sveltekit';
import { createServerLogger } from '$lib/server/logger';

export type QuotaCheckResult = {
	allowed: boolean;
	plan: 'free' | 'supporter';
	scansRemaining: number;
	reason?: string;
};

/**
 * Check and decrement user quota using the new Supabase quota system
 */
export async function checkAndDecrementQuota(userId: string): Promise<QuotaCheckResult> {
	try {
		const adminSupabase = getAdminSupabase() as unknown as {
			rpc: (
				fn: string,
				args: Record<string, unknown>
			) => Promise<{ data: { allowed: boolean; scans_remaining: number } | null; error: unknown }>;
		};

		// Call the increment_quota_usage RPC function
		const { data, error } = await adminSupabase.rpc('increment_quota_usage', {
			p_user_id: userId
		});

		if (error) {
			createServerLogger('lib.quota').warn('Quota check failed, allowing request', { details: { error: String(error) } });
			Sentry.captureException(error, { tags: { context: 'quota_check' } });
			return { allowed: true, plan: 'free', scansRemaining: 10 };
		}

		if (!data) {
			return { allowed: true, plan: 'free', scansRemaining: 10 };
		}

		return {
			allowed: data.allowed,
			plan: 'free',
			scansRemaining: data.scans_remaining,
			reason: !data.allowed ? 'Daily scan quota exceeded. Upgrade to Supporter plan for more scans.' : undefined
		};
	} catch (err) {
		createServerLogger('lib.quota').warn('Quota enforcement error, allowing request', { details: { error: String(err) } });
		Sentry.captureException(err, { tags: { context: 'quota_enforcement' } });
		return { allowed: true, plan: 'free', scansRemaining: 10 };
	}
}

/**
 * Get user quota information without decrementing
 */
export async function getUserQuota(userId: string) {
	try {
		const adminSupabase = getAdminSupabase() as unknown as {
			rpc: (
				fn: string,
				args: Record<string, unknown>
			) => Promise<{ data: { allowed: boolean; scans_remaining: number; plan?: string } | null; error: unknown }>;
		};

		const { data, error } = await adminSupabase.rpc('check_user_quota', {
			p_user_id: userId
		});

		if (error || !data) {
			return { plan: 'free', scansRemaining: 10, allowed: true };
		}

		return {
			plan: (data.plan as 'free' | 'supporter') || 'free',
			scansRemaining: data.scans_remaining,
			allowed: data.allowed
		};
	} catch (err) {
		Sentry.captureException(err, { tags: { context: 'quota_read' } });
		return { plan: 'free', scansRemaining: 10, allowed: true };
	}
}
