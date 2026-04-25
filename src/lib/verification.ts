export type VerificationResult = {
	barcode: string;
	product_name?: string;
	brand: string;
	legal_holding_company?: string;
	country_of_origin?: string;
	parent_company: string;
	origin_country: string;
	is_flagged: boolean;
	flag_reason?: string;
	confidence_score?: number;
	data_sources_used?: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'>;
	reasoning: string;
	error?: string;
};