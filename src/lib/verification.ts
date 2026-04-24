export type VoteAction = 'verify' | 'correct';

export type VerificationStatus = 'verified' | 'pending' | 'review';

export type VerificationResult = {
	barcode: string;
	name: string;
	brand: string;
	context_text: string;
	reasoning: string;
	is_israeli: boolean;
	confidence: number;
	status: VerificationStatus;
	source: 'fast-pass' | 'openrouter' | 'consensus' | 'cached' | 'fallback';
	vote_count?: number;
	verify_votes?: number;
	correct_votes?: number;
	needs_review?: boolean;
	error?: string;
};