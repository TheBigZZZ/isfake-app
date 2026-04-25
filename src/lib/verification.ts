export type VerificationResult = {
	barcode: string;
	product_identity?: {
		verified_name: string;
		brand: string;
		verified_brand: string;
		category: string;
		confidence_score: number;
	};
	origin_details?: {
		physical_origin_country: string;
		legal_registration_prefix: string;
	};
	corporate_structure?: {
		ultimate_parent_company: string;
		global_hq_country: string;
	};
	compliance?: {
		is_flagged: boolean;
		flag_reason: string | null;
	};
	ownership_structure?: {
		manufacturer: string;
		ultimate_parent: string;
		parent_hq_country: string;
	};
	compliance_status?: {
		is_flagged: boolean;
		flag_reason: string | null;
	};
	arbitration_log?: string;
	product_name?: string;
	verified_brand?: string;
	brand: string;
	legal_holding_company?: string;
	holding_company_hq?: string;
	country_of_origin?: string;
	parent_company: string;
	origin_country: string;
	is_flagged: boolean;
	flag_reason?: string;
	confidence_score?: number;
	source_attribution?: 'Internal_Knowledge' | 'GS1_Registry' | 'Search_Scrape';
	data_sources_used?: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'>;
	reasoning: string;
	error?: string;
};