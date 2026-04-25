export type VerificationResult = {
	barcode: string;
	brand: string;
	parent_company: string;
	origin_country: string;
	is_flagged: boolean;
	reasoning: string;
	error?: string;
};