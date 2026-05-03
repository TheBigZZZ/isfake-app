import { createClient } from '@supabase/supabase-js';
import type { VerificationResult } from '$lib/verification';

// TODO: Replace with your projected Supabase URL and Anon Key
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'public-anon-key';
const verifyApiUrl = import.meta.env.VITE_VERIFY_API_URL?.replace(/\/$/, '') || '/api/scan';

export const supabase = createClient(supabaseUrl, supabaseKey, {
	auth: {
		persistSession: true,
		autoRefreshToken: true,
		detectSessionInUrl: true
	}
});

function getAuthRedirectUrl(path: string) {
	if (typeof window === 'undefined') {
		return path;
	}

	return new URL(path, window.location.origin).toString();
}

export async function signInWithGoogle() {
	return supabase.auth.signInWithOAuth({
		provider: 'google',
		options: {
			redirectTo: getAuthRedirectUrl('/auth/callback'),
			queryParams: {
				access_type: 'offline',
				prompt: 'consent'
			}
		}
	});
}

type ScanRequestBody = {
	barcode?: string;
	action?: 'scan';
	ocr_text?: string;
	image_data_url?: string;
	image_base64?: string;
	image_url?: string;
};

async function postVerificationRequest(body: ScanRequestBody): Promise<VerificationResult> {
	const response = await fetch(verifyApiUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body)
	});

	const contentType = response.headers.get('content-type') || '';
	const responseText = await response.text();

	if (!response.ok) {
		throw new Error(responseText || `Verification request failed with status ${response.status}.`);
	}

	if (!contentType.includes('application/json')) {
		const snippet = responseText.slice(0, 120).replace(/\s+/g, ' ');
		throw new Error(
			snippet
				? `Verification endpoint returned non-JSON content. Check that VITE_VERIFY_API_URL points to a live backend. Response started with: ${snippet}`
				: 'Verification endpoint returned non-JSON content. Check that VITE_VERIFY_API_URL points to a live backend.'
		);
	}

	return JSON.parse(responseText) as VerificationResult;
}

export async function verifyBarcode(barcode: string) {
	return postVerificationRequest({ barcode, action: 'scan' });
}

export async function verifyScan(barcode?: string, extras: Omit<ScanRequestBody, 'barcode' | 'action'> = {}) {
	return postVerificationRequest({ ...(barcode ? { barcode } : {}), action: 'scan', ...extras });
}

export async function fetchRecentIdentifications() {
	try {
		const { data: { user } } = await supabase.auth.getUser();
		if (!user) return [];

		const { data, error } = await supabase
			.from('scans')
			.select('id, product_name, status, created_at')
			.eq('user_id', user.id)
			.order('created_at', { ascending: false })
			.limit(10);

		if (error) {
			console.error('Failed to fetch recent identifications:', error);
			return [];
		}

		return (data || []).map((item: any) => ({
			...item,
			timestamp: item.created_at
		}));
	} catch (error) {
		console.error('Error fetching recent identifications:', error);
		return [];
	}
}