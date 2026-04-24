import { getAdminSupabase } from './supabase';
import type { VerificationResult, VoteAction } from '$lib/verification';

function normalizeText(value: string | null | undefined) {
	return (value ?? '').replace(/\s+/g, ' ').trim();
}

function toVerificationResult(args: {
	barcode: string;
	name: string;
	brand: string;
	contextText: string;
	reasoning: string;
	isIsraeli: boolean;
	confidence: number;
	status: VerificationResult['status'];
	source: VerificationResult['source'];
	needsReview?: boolean;
	voteCount?: number;
	verifyVotes?: number;
	correctVotes?: number;
}): VerificationResult {
	return {
		barcode: args.barcode,
		name: args.name,
		brand: args.brand,
		context_text: args.contextText,
		reasoning: args.reasoning,
		is_israeli: args.isIsraeli,
		confidence: args.confidence,
		status: args.status,
		source: args.source,
		needs_review: args.needsReview,
		vote_count: args.voteCount,
		verify_votes: args.verifyVotes,
		correct_votes: args.correctVotes
	};
}

export async function voteOnBarcode(args: {
	barcode: string;
	isIsraeli: boolean;
	voteAction: VoteAction;
	name?: string;
	brand?: string;
	contextText?: string;
	reasoning?: string;
	confidence?: number;
}): Promise<VerificationResult> {
	const normalizedBarcode = normalizeText(args.barcode);
	if (!normalizedBarcode) {
		throw new Error('Barcode is required.');
	}

	const adminSupabase = getAdminSupabase() as any;

	const { data, error } = await adminSupabase.rpc('increment_and_verify', {
		p_barcode: normalizedBarcode,
		p_is_israeli: args.isIsraeli,
		p_vote_action: args.voteAction,
		p_name: args.name ?? null,
		p_brand: args.brand ?? null,
		p_context_text: args.contextText ?? null,
		p_reasoning: args.reasoning ?? null,
		p_ai_confidence: args.confidence ?? null
	});

	if (error) {
		throw error;
	}

	const result = (data as {
		barcode?: string;
		is_israeli?: boolean;
		vote_count?: number;
		verify_votes?: number;
		correct_votes?: number;
		verified?: boolean;
		name?: string;
		brand?: string;
		context_text?: string;
		reasoning?: string;
		confidence?: number;
	} | null) ?? null;

	return toVerificationResult({
		barcode: result?.barcode ?? normalizedBarcode,
		name: result?.name ?? args.name ?? `Barcode ${normalizedBarcode}`,
		brand: result?.brand ?? args.brand ?? 'UNKNOWN BRAND',
		contextText: result?.context_text ?? args.contextText ?? '',
		reasoning: result?.reasoning ?? args.reasoning ?? 'Community consensus recorded.',
		isIsraeli: Boolean(result?.is_israeli ?? args.isIsraeli),
		confidence: typeof result?.confidence === 'number' ? result.confidence : Number(args.confidence ?? 0.75),
		status: result?.verified ? 'verified' : 'pending',
		source: 'consensus',
		needsReview: !result?.verified,
		voteCount: result?.vote_count,
		verifyVotes: result?.verify_votes,
		correctVotes: result?.correct_votes
	});
}