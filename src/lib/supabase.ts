import { createClient } from '@supabase/supabase-js';
import type { VerificationResult } from '$lib/verification';

// TODO: Replace with your projected Supabase URL and Anon Key
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'public-anon-key';
const verifyApiUrl = import.meta.env.VITE_VERIFY_API_URL?.replace(/\/$/, '') || '/api/verify';

export const supabase = createClient(supabaseUrl, supabaseKey);

async function postVerificationRequest(body: Record<string, unknown>): Promise<VerificationResult> {
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