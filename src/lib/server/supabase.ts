import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

let adminSupabaseClient: ReturnType<typeof createClient> | null = null;

export function getAdminSupabase() {
	if (!adminSupabaseClient) {
		const supabaseUrl = env.SUPABASE_URL;
		const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

		if (!supabaseUrl || !supabaseServiceRoleKey) {
			throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for the verification server module.');
		}

		adminSupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
			auth: {
				autoRefreshToken: false,
				persistSession: false
			}
		});
	}

	return adminSupabaseClient;
}