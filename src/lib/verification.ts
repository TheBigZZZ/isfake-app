export type VerificationResult = {
	barcode: string;
	scan_guidance?: {
		next_step: 'camera_ocr' | string;
		message: string;
	};
	product_identity?: {
		verified_name: string;
		brand: string;
		verified_brand: string;
		category: string;
		confidence?: number;
		confidence_score: number;
	};
	origin_data?: {
		physical_origin: string;
		legal_prefix_country: string;
	};
	origin_details?: {
		physical_origin_country: string;
		legal_registration_prefix: string;
		source_of_origin?: string;
	};
	corporate_structure?: {
		ultimate_parent_company: string;
		global_hq_country: string;
	};
	corporate_hierarchy?: {
		immediate_owner?: string;
		ultimate_parent: string;
		parent_hq_country: string;
		ownership_chain: string;
	};
	compliance?: {
		is_flagged: boolean;
		flag_reason: string | null;
		reason?: string | null;
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