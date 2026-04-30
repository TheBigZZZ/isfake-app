import { json } from '@sveltejs/kit';
import { env as dynamicEnv } from '$env/dynamic/private';
import { OPENROUTER_API_KEY, SEARCH_API_KEY } from '$env/static/private';
import * as cheerio from 'cheerio';
import type { RequestHandler } from './$types';
import { getAdminSupabase } from '$lib/server/supabase';

type VerifyBody = {
	barcode?: string;
	action?: 'scan';
	ocr_text?: string;
	image_data_url?: string;
	image_base64?: string;
	image_url?: string;
};

type OpenFoodFactsProduct = {
	product_name?: string;
	brands?: string;
	brand_owner?: string;
	manufacturer_name?: string;
	brands_tags?: string[] | string;
	owner_name?: string;
	owner?: string;
	manufacturing_places?: string;
	generic_name?: string;
	categories?: string;
	countries?: string;
	ingredients_text?: string;
};

type SerperOrganicResult = {
	title?: string;
	snippet?: string;
	link?: string;
};

type SerperPayload = {
	organic?: SerperOrganicResult[];
	knowledgeGraph?: {
		title?: string;
		type?: string;
		description?: string;
	};
};

type SerperSearchResult = {
	query: string;
	contextText: string;
	compactContext?: string;
	statusCode: number;
	used: boolean;
	snippetCount?: number;
};

type SerperPrimaryResult = {
	result: SerperSearchResult;
	retried: boolean;
	primaryQuery: string;
	retryQuery: string | null;
	firstAttemptSnippets: number;
};

type PublicVerificationResult = {
	company: string;
	hqCountry: string;
	website: string;
	source: 'Wikidata' | 'OfficialSite' | 'Registry';
	score: number;
	evidence: string;
};

type EvidenceBundle = {
	product_name: string;
	brand: string;
	parent_company: string;
	parent_hq_country: string;
	origin_country: string;
	category: string;
	sources: string[];
};

type VerifiedField = {
	value: string | boolean;
	accepted: boolean;
	confidence: number; // 0-1
	supporting_sources: Array<{ source: string; url?: string; excerpt?: string }>;
	reason?: string;
};

type VerifiedResult = {
	brand: VerifiedField;
	parent_company: VerifiedField;
	parent_hq_country: VerifiedField;
	origin_country: VerifiedField;
	category: VerifiedField;
	is_flagged: VerifiedField;
	overall_confidence: number;
	notes?: string[];
};

type ScanQuota = {
	allowed: boolean;
	plan: 'free' | 'supporter';
	scansRemaining: number;
	reason?: string;
};

type BarcodeValidation = {
	valid: boolean;
	type: 'EAN-8' | 'EAN-13' | 'UPC-A' | 'GTIN-14' | 'unknown';
	digits: string;
	gs1Country?: string;
	error?: string;
};

type UPCItemDBResult = {
	title: string;
	brand: string;
	category: string;
	description: string;
};

type ScanEvidenceInput = {
	ocr_text?: string;
	image_data_url?: string;
	image_base64?: string;
	image_url?: string;
};

async function runLLMSelfCheck(args: {
	barcode: string;
	evidenceBundleBlock: string;
	aiSnapshot: unknown;
	marketPulse: string;
	deepScrape: string;
	registryData: string;
	hqPulse: string;
}): Promise<Partial<VerifiedResult> | null> {
	if (!OPENROUTER_API_KEY) return null;

	try {
		// Reuse callOpenRouterAnalyzer path as a best-effort LLM verifier by asking for a compact JSON
		const verificationPrompt = `You are a verifier. Given the AI's extracted fields and the following evidence (OFF registry, market snippets, deep scrape, HQ pulse), return a JSON object with fields: brand, parent_company, parent_hq_country, origin_country, category, is_flagged. For each field include {value, accept:true|false, confidence:0-1, supporting_sources:[{source,url,excerpt}], reason}. Evidence: ${args.evidenceBundleBlock}\n\nAI_OUTPUT:${JSON.stringify(
			args.aiSnapshot
		)}\n\nMARKET_PULSE:${args.marketPulse}\n\nDEEP_SCRAPE:${args.deepScrape}\n\nREGISTRY:${args.registryData}\n\nHQ_PULSE:${args.hqPulse}`;

		// Build typed args for callOpenRouterAnalyzer so it routes through the existing OpenRouter flow
		const verifierArgsForCall = {
			barcode: args.barcode,
			registryData: args.registryData,
			marketPulse: args.marketPulse,
			offData: args.registryData,
			searchContext: args.marketPulse,
			deepScrape: args.deepScrape,
			hqPulse: args.hqPulse,
			truthBundleBlock: `VERIFIER_PROMPT:\n${verificationPrompt}`,
			evidenceBundle: args.evidenceBundleBlock,
			contextText: `${args.marketPulse}\n${args.deepScrape}\n${args.registryData}`,
			searchPresent: Boolean(args.marketPulse || args.deepScrape),
			snippetsCount: 0,
			keyIndicators: [],
			arbitrationPath: 'llm_self_check',
			offProduct: null,
			sourcesUsed: ['Search_Scrape'] as Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'>
		} as Parameters<typeof callOpenRouterAnalyzer>[0];

		const llmResult = await callOpenRouterAnalyzer(verifierArgsForCall).catch(() => null);

		if (!llmResult) return null;

		// Map available ai-like fields into VerifiedResult partial structure
		const mapField = (val: unknown, src = 'LLM'): VerifiedField | undefined => {
			if (val === undefined || val === null) return undefined;
			const s = String(val);
			return {
				value: s,
				accepted: true,
				confidence: s.length > 0 ? 0.8 : 0.5,
				supporting_sources: [{ source: src }],
				reason: 'Verified by LLM self-check'
			} as VerifiedField;
		};

		const partial: Partial<VerifiedResult> = {};
		partial.brand = mapField(llmResult.product?.brand || llmResult.brand) || undefined;
		partial.parent_company = mapField(llmResult.product?.ultimate_parent || llmResult.parent_company) || undefined;
		partial.parent_hq_country = mapField(llmResult.product?.hq || llmResult.parent_hq_country) || undefined;
		partial.origin_country = mapField(llmResult.origin_data?.physical_origin || llmResult.origin_country) || undefined;
		partial.category = mapField(llmResult.product_identity?.category || llmResult.category) || undefined;
		partial.is_flagged = { value: !!llmResult.compliance?.is_flagged || false, accepted: false, confidence: 0.2, supporting_sources: [] };

		return partial;
	} catch {
		return null;
	}
}

function scoreAndDecideField(fieldName: string, aiValue: string, offValue: string | null, publicVerification: PublicVerificationResult | null, marketText: string, deepScrape: string, llmSelf?: Partial<VerifiedResult>, hqAnchor?: string): VerifiedField {
	const supporting_sources: VerifiedField['supporting_sources'] = [];
	const normalizedAi = normalizeText(aiValue || '');
	const normalizedOff = normalizeText(offValue || '');
	const normalizedHqAnchor = normalizeText(hqAnchor || '');

	// Official/Wikidata strong accept
	if (publicVerification && publicVerification.company) {
		if (fieldName === 'parent_company') {
			supporting_sources.push({ source: `Official:${publicVerification.source}`, url: publicVerification.website, excerpt: publicVerification.evidence });
			return { value: publicVerification.company, accepted: true, confidence: 0.95, supporting_sources, reason: 'Official/Wikidata match' };
		}
		if (
			fieldName === 'parent_hq_country' &&
			publicVerification.hqCountry &&
			(normalizeText(publicVerification.source) === 'OfficialSite' || normalizeText(publicVerification.source) === 'Registry') &&
			normalizedHqAnchor &&
			companyHasHqEvidence(normalizedHqAnchor, `${publicVerification.evidence}\n${publicVerification.website}`, normalizedHqAnchor)
		) {
			supporting_sources.push({ source: `Official:${publicVerification.source}`, url: publicVerification.website, excerpt: publicVerification.evidence });
			return { value: publicVerification.hqCountry, accepted: true, confidence: 0.95, supporting_sources, reason: 'Official/Wikidata HQ match' };
		}
	}

	// OFF authoritative for origin and category
	if (fieldName === 'origin_country' && normalizedOff) {
		supporting_sources.push({ source: 'OFF' });
		return { value: normalizedOff, accepted: true, confidence: 0.95, supporting_sources, reason: 'OFF authoritative' };
	}
	if (fieldName === 'category' && normalizedOff) {
		supporting_sources.push({ source: 'OFF' });
		return { value: normalizedOff, accepted: true, confidence: 0.9, supporting_sources, reason: 'OFF authoritative' };
	}

	// If LLM self-check suggests a value with high confidence, accept it
	const llmField = fieldName === 'parent_hq_country' ? undefined : llmSelf ? (llmSelf as unknown as Record<string, VerifiedField | undefined>)[fieldName] : undefined;
	if (llmField && llmField.accepted && llmField.confidence >= 0.8) {
		supporting_sources.push({ source: 'LLM-self-check' });
		return { value: llmField.value as string, accepted: true, confidence: llmField.confidence, supporting_sources, reason: 'LLM self-check accepted' };
	}

	// Snippet-based acceptance: require at least 2 independent signals across market + deepScrape
	const snippetText = `${marketText || ''}\n${deepScrape || ''}`;
	let evidenceScore = 0;
	if (fieldName === 'parent_company') {
		if (companyValueHasEvidenceSupport(aiValue, snippetText)) evidenceScore += 1;
		if (companyValueHasEvidenceSupport(normalizedOff, snippetText)) evidenceScore += 1;
		if (publicVerification && publicVerification.company && publicVerification.company.toLowerCase() === normalizedAi.toLowerCase()) evidenceScore += 2;
	}
	if (fieldName === 'parent_hq_country') {
		if (normalizedHqAnchor && companyHasHqEvidence(normalizedHqAnchor, snippetText, normalizedHqAnchor)) evidenceScore += 2;
		if (normalizedHqAnchor && inferHqCountryFromEvidence(snippetText, normalizedHqAnchor) === aiValue) evidenceScore += 1;
		if (publicVerification && (publicVerification.source === 'OfficialSite' || publicVerification.source === 'Registry') && inferCountryFromText(publicVerification.hqCountry) === normalizedAi) evidenceScore += 2;
	}
	if (fieldName === 'origin_country') {
		if (inferOriginCountryFromEvidence(snippetText) === aiValue) evidenceScore += 2;
	}

	const minimumEvidenceScore = fieldName === 'parent_hq_country' ? 3 : 2;
	if (evidenceScore >= minimumEvidenceScore) {
		supporting_sources.push({ source: 'Serper/Scraper corroboration' });
		return { value: aiValue || (normalizedOff || 'Unresolved'), accepted: true, confidence: 0.75, supporting_sources, reason: 'Corroborated by >=2 snippets' };
	}

	// Last resort: accept AI if it matches OFF or appears in snippet once together with AI confidence
	if (normalizedAi && (normalizedAi === normalizedOff || normalizedAi.length > 3 && snippetText.toLowerCase().includes(normalizedAi.toLowerCase()))) {
		supporting_sources.push({ source: 'AI+Snippets' });
		return { value: aiValue, accepted: true, confidence: 0.6, supporting_sources, reason: 'AI value appears in snippets or matches OFF' };
	}

	// Reject by default; prefer OFF/Official/Wikidata or remain unresolved
	return { value: aiValue || 'Unresolved', accepted: false, confidence: 0.2, supporting_sources, reason: 'Insufficient corroborating evidence; rejected by verifier' };
}

function applyVerificationToAi(ai: unknown, verified: VerifiedResult) {
	const target = ai as unknown as Record<string, unknown>;
	// Apply accepted fields back onto ai result
	if (verified.brand && verified.brand.accepted) (target as Record<string, unknown>)['brand'] = String(verified.brand.value) as unknown;
	if (verified.parent_company && verified.parent_company.accepted) {
		(target as Record<string, unknown>)['parent_company'] = String(verified.parent_company.value) as unknown;
		const prod = ((target as Record<string, unknown>)['product'] as Record<string, unknown> | undefined) || ({} as Record<string, unknown>);
		prod['ultimate_parent'] = String(verified.parent_company.value) as unknown;
		(target as Record<string, unknown>)['product'] = prod as unknown;
	}
	if (verified.parent_hq_country && verified.parent_hq_country.accepted) {
		(target as Record<string, unknown>)['parent_hq_country'] = String(verified.parent_hq_country.value) as unknown;
		(target as Record<string, unknown>)['holding_company_hq'] = String(verified.parent_hq_country.value) as unknown;
		const prod = (target as Record<string, unknown>)['product'] as Record<string, unknown> | undefined;
		if (prod) prod['hq'] = String(verified.parent_hq_country.value) as unknown;
	}
	if (verified.origin_country && verified.origin_country.accepted) {
		(target as Record<string, unknown>)['origin_country'] = String(verified.origin_country.value) as unknown;
		(target as Record<string, unknown>)['country_of_origin'] = String(verified.origin_country.value) as unknown;
	}
	if (verified.category && verified.category.accepted) {
		(target as Record<string, unknown>)['category'] = String(verified.category.value) as unknown;
		const pid = (target as Record<string, unknown>)['product_identity'] as Record<string, unknown> | undefined;
		if (pid) pid['category'] = String(verified.category.value) as unknown;
	}
	if (verified.is_flagged && verified.is_flagged.accepted) {
		(target as Record<string, unknown>)['is_flagged'] = Boolean(verified.is_flagged.value) as unknown;
	}
}

type OpenRouterAnalyzerResult = OpenRouterCorporateOutput & {
	parent_hq_country?: string;
	category?: string;
	[key: string]: unknown;
};

type OpenRouterCorporateOutput = {
	barcode: string;
	product: {
		verified_name?: string;
		name: string;
		brand: string;
		ultimate_parent: string;
		parent: string;
		hq: string;
		category?: string;
		confidence?: number;
	};
	audit?: {
		parent_evidence: string;
		hq_evidence: string;
	};
	forensic_report?: {
		scraper_blocked: boolean;
		serper_fallback_active: boolean;
		ground_truth_source: 'Serper' | 'Scraper' | 'OFF';
		rationale: string;
	};
	forensic_audit?: {
		scraper_blocked: boolean;
		serper_snippets_received: number;
		source_hierarchy: string;
		conflict_resolved: boolean;
		rationale: string;
	};
	telemetry: {
		search_present: boolean;
		snippets_count: number;
		arbitration_path: string;
		search_data_received: boolean;
		key_indicators: string[];
		decision_logic: string;
	};
	verification: {
		sources_synced: Array<'OFF' | 'Serper' | 'Internal'>;
		conflicts_resolved: string;
		confidence_score: number;
	};
	parent_hq_country?: string;
	category?: string;
	corporate_hierarchy?: {
		immediate_owner: string;
		ultimate_parent: string;
		parent_hq_country: string;
		ownership_chain: string;
	};
	product_identity: {
		verified_name: string;
		brand: string;
		verified_brand?: string;
		category: string;
		confidence?: number;
		confidence_score: number;
	};
	origin_data?: {
		physical_origin: string;
		legal_prefix_country: string;
	};
	origin_details: {
		physical_origin_country: string;
		legal_registration_prefix: string;
		source_of_origin?: string;
	};
	corporate_structure: {
		ultimate_parent_company: string;
		global_hq_country: string;
	};
	compliance: {
		is_flagged: boolean;
		flag_reason: string | null;
		reason?: string | null;
	};
	ownership_structure: {
		manufacturer: string;
		ultimate_parent: string;
		parent_hq_country: string;
	};
    
	compliance_status: {
		is_flagged: boolean;
		flag_reason: string | null;
	};
	arbitration_log: string;
	product_name: string;
	verified_brand: string;
	brand: string;
	legal_holding_company: string;
	holding_company_hq: string;
	country_of_origin: string;
	is_flagged: boolean;
	flag_reason: string;
	confidence_score: number;
	source_attribution: string;
	data_sources_used: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'>;
	parent_company: string;
	origin_country: string;
	reasoning: string;
	error?: string;
	geopolitical_audit?: {
		status: string;
		evidence: string;
		israeli_related: boolean;
	};
	verification_card_label?: string;
};

type CachedProductRow = {
	barcode: string;
	brand: string;
	parent_company: string;
	origin_country: string;
	is_flagged: boolean;
	category?: string | null;
	parent_hq_country?: string | null;
	source_attribution?: string | null;
	arbitration_log?: string | null;
};

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPEN_FOOD_FACTS_API_URL = 'https://world.openfoodfacts.org/api/v2/product';
const SERPER_API_URL = 'https://google.serper.dev/search';
const OPENROUTER_MODEL = dynamicEnv.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
const BROWSER_ACCEPT_HEADER =
	'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const GOOGLE_MOBILE_USER_AGENT =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const STEALTH_USER_AGENTS = [
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
	GOOGLE_MOBILE_USER_AGENT
];
const STEALTH_ACCEPT_LANGUAGES = ['en-US,en;q=0.9', 'en-GB,en;q=0.8', 'en-US,en;q=0.7'];
const STEALTH_REFERERS = ['https://www.google.com/', 'https://duckduckgo.com/', 'https://www.bing.com/'];
const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 600;
const JITTER_GOOGLE_MIN_MS = 1500;
const JITTER_GOOGLE_MAX_MS = 2500;

const GS1_PREFIX_MAP: Array<[string | [number, number], string]> = [
	[[0, 19], 'United States'],
	[[20, 29], 'United States'],
	[[30, 39], 'United States'],
	[[40, 49], 'United States'],
	[[50, 59], 'United States'],
	[[60, 139], 'United States'],
	[[300, 379], 'France'],
	['380', 'Bulgaria'],
	['383', 'Slovenia'],
	['385', 'Croatia'],
	['387', 'Bosnia and Herzegovina'],
	['389', 'Montenegro'],
	[[400, 440], 'Germany'],
	[[450, 459], 'Japan'],
	[[460, 469], 'Russia'],
	['470', 'Kyrgyzstan'],
	['471', 'Taiwan'],
	['474', 'Estonia'],
	['475', 'Latvia'],
	['476', 'Azerbaijan'],
	['477', 'Lithuania'],
	['478', 'Uzbekistan'],
	['479', 'Sri Lanka'],
	['480', 'Philippines'],
	['481', 'Belarus'],
	['482', 'Ukraine'],
	['484', 'Moldova'],
	['485', 'Armenia'],
	['486', 'Georgia'],
	['487', 'Kazakhstan'],
	['488', 'Tajikistan'],
	['489', 'Hong Kong'],
	[[490, 499], 'Japan'],
	[[500, 509], 'United Kingdom'],
	['520', 'Greece'],
	['528', 'Lebanon'],
	['529', 'Cyprus'],
	['530', 'Albania'],
	['531', 'North Macedonia'],
	['535', 'Malta'],
	['539', 'Ireland'],
	[[540, 549], 'Belgium'],
	['560', 'Portugal'],
	['569', 'Iceland'],
	[[570, 579], 'Denmark'],
	['590', 'Poland'],
	['594', 'Romania'],
	['599', 'Hungary'],
	['600', 'South Africa'],
	['601', 'South Africa'],
	['603', 'Ghana'],
	['604', 'Senegal'],
	['608', 'Bahrain'],
	['609', 'Mauritius'],
	['611', 'Morocco'],
	['613', 'Algeria'],
	['615', 'Nigeria'],
	['616', 'Kenya'],
	['618', 'Ivory Coast'],
	['619', 'Tunisia'],
	['620', 'Tanzania'],
	['621', 'Syria'],
	['622', 'Egypt'],
	['624', 'Libya'],
	['625', 'Jordan'],
	['626', 'Iran'],
	['627', 'Kuwait'],
	['628', 'Saudi Arabia'],
	['629', 'United Arab Emirates'],
	[[640, 649], 'Finland'],
	[[690, 699], 'China'],
	[[700, 709], 'Norway'],
	['729', 'Israel'],
	[[730, 739], 'Sweden'],
	['740', 'Guatemala'],
	['741', 'El Salvador'],
	['742', 'Honduras'],
	['743', 'Nicaragua'],
	['744', 'Costa Rica'],
	['745', 'Panama'],
	['746', 'Dominican Republic'],
	['750', 'Mexico'],
	['754', 'Canada'],
	['755', 'Canada'],
	['759', 'Venezuela'],
	[[760, 769], 'Switzerland'],
	['770', 'Colombia'],
	['773', 'Uruguay'],
	['775', 'Peru'],
	['777', 'Bolivia'],
	['778', 'Argentina'],
	['779', 'Argentina'],
	['780', 'Chile'],
	['784', 'Paraguay'],
	['786', 'Ecuador'],
	['789', 'Brazil'],
	['790', 'Brazil'],
	[[800, 839], 'Italy'],
	[[840, 849], 'Spain'],
	['850', 'Cuba'],
	['858', 'Slovakia'],
	['859', 'Czech Republic'],
	['860', 'Serbia'],
	['865', 'Mongolia'],
	['867', 'North Korea'],
	['868', 'Turkey'],
	['869', 'Turkey'],
	[[870, 879], 'Netherlands'],
	['880', 'South Korea'],
	['883', 'Myanmar'],
	['884', 'Cambodia'],
	['885', 'Thailand'],
	['888', 'Singapore'],
	['890', 'India'],
	['893', 'Vietnam'],
	['896', 'Pakistan'],
	['899', 'Indonesia'],
	[[900, 919], 'Austria'],
	[[930, 939], 'Australia'],
	[[940, 949], 'New Zealand'],
	['955', 'Malaysia'],
	['958', 'Macau']
];

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function lookupGs1Country(barcode: string): string {
	const digits = barcode.replace(/\D/g, '');
	if (digits.length < 3) return 'Unresolved GS1 Country';
	const prefix3 = Number.parseInt(digits.slice(0, 3), 10);
	const prefix2 = Number.parseInt(digits.slice(0, 2), 10);

	for (const [key, country] of GS1_PREFIX_MAP) {
		if (Array.isArray(key)) {
			const [min, max] = key;
			if (prefix3 >= min && prefix3 <= max) return country;
			continue;
		}

		const numeric = Number.parseInt(key, 10);
		if (key.length === 3 && prefix3 === numeric) return country;
		if (key.length === 2 && prefix2 === numeric) return country;
	}

	return 'Unresolved GS1 Country';
}

function validateMod10Checksum(digits: string): boolean {
	if (!/^\d+$/.test(digits) || digits.length < 2) return false;
	const body = digits.slice(0, -1);
	const checkDigit = Number.parseInt(digits.slice(-1), 10);
	let sum = 0;
	for (let index = body.length - 1, position = 0; index >= 0; index--, position++) {
		const digit = Number.parseInt(body[index], 10);
		const multiplier = position % 2 === 0 ? 3 : 1;
		sum += digit * multiplier;
	}
	return (10 - (sum % 10)) % 10 === checkDigit;
}

function validateBarcode(barcode: string): BarcodeValidation {
	const digits = barcode.replace(/\D/g, '');
	const gs1Country = lookupGs1Country(digits);

	if (digits.length === 8) {
		return { valid: validateMod10Checksum(digits), type: 'EAN-8', digits, gs1Country };
	}

	if (digits.length === 12) {
		return { valid: validateMod10Checksum(`0${digits}`), type: 'UPC-A', digits, gs1Country };
	}

	if (digits.length === 13) {
		return { valid: validateMod10Checksum(digits), type: 'EAN-13', digits, gs1Country };
	}

	if (digits.length === 14) {
		return { valid: validateMod10Checksum(digits), type: 'GTIN-14', digits, gs1Country };
	}

	return { valid: false, type: 'unknown', digits, gs1Country, error: `Invalid barcode length: ${digits.length}` };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const existing = rateLimitStore.get(ip);
	if (!existing || now > existing.resetAt) {
		rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return true;
	}

	if (existing.count >= RATE_LIMIT_MAX) return false;
	existing.count += 1;
	return true;
}

setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of rateLimitStore.entries()) {
		if (now > entry.resetAt) rateLimitStore.delete(key);
	}
}, 300_000);

async function lookupUPCItemDB(barcode: string): Promise<UPCItemDBResult | null> {
	try {
		const response = await withTimeout(
			fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`, {
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'isfake-app/1.0'
				}
			}),
			3500,
			null as Response | null
		);

		if (!response || !response.ok) return null;

		const data = (await response.json()) as { items?: Array<{ title?: string; brand?: string; category?: string; description?: string }> };
		const item = data.items?.[0];
		if (!item) return null;

		return {
			title: normalizeText(item.title),
			brand: normalizeText(item.brand),
			category: normalizeText(item.category),
			description: normalizeText(item.description)
		};
	} catch {
		return null;
	}
}

async function lookupWikipediaBrand(brandName: string): Promise<{ parentCompany: string; country: string; summary: string } | null> {
	const normalizedBrand = normalizeText(brandName);
	if (!normalizedBrand || isUnresolved(normalizedBrand)) return null;

	const candidates = buildBrandAliasCandidates(normalizedBrand);

	for (const candidate of candidates.length > 0 ? candidates : [normalizedBrand]) {
		for (const wikiCandidate of [candidate, `${candidate} company`, `${candidate} brand`, `${candidate} (company)`]) {
			try {
				const response = await withTimeout(
					fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiCandidate)}`, {
						headers: {
							'User-Agent': 'isfake-app/1.0'
						}
					}),
					3500,
					null as Response | null
				);

				if (!response || !response.ok) continue;

				const data = (await response.json()) as { extract?: string };
				const summary = normalizeText(data.extract || '');
				if (!summary) continue;

				const parentMatch = summary.match(/(?:subsidiary of|owned by|division of|part of)\s+([A-Z][A-Za-z0-9&\s,.'-]{2,80})/i);
				const country = inferCountryFromText(summary);

				return {
					parentCompany: normalizeText(parentMatch?.[1] || ''),
					country,
					summary: summary.slice(0, 300)
				};
			} catch {
				continue;
			}
}
	}

	return null;
}
const ALLOWED_ORIGINS = new Set([
	'https://localhost',
	'https://localhost:5173',
	'http://localhost',
	'http://localhost:5173',
	'capacitor://localhost',
	'https://isfake-app.onrender.com'
]);

const RETAILER_TERMS = [
	'albert heijn',
	'walmart',
	'tesco',
	'carrefour',
	'dollar general',
	'kroger',
	'costco',
	'whole foods',
	'amazon',
	'aldi',
	'lidl',
	'sainsbury',
	'asda',
	'target'
];

const PRIVATE_LABEL_TERMS = [
	'great value',
	'kirkland',
	'equate',
	'member\'s mark',
	'tesco finest',
	'carrefour classic',
	'simple truth'
];

const FOOD_KEYWORDS = [
	'food',
	'beverage',
	'drink',
	'snack',
	'juice',
	'soda',
	'water',
	'milk',
	'coffee',
	'tea',
	'chocolate',
	'candy',
	'cookie',
	'cereal',
	'pasta',
	'sauce'
];

const ELECTRONICS_KEYWORDS = [
	'electronic',
	'electronics',
	'phone',
	'laptop',
	'charger',
	'headphones',
	'bluetooth',
	'usb',
	'tv',
	'monitor',
	'camera',
	'gaming'
];

function corsHeaders(origin: string | null) {
	const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://localhost';

	return {
		'Access-Control-Allow-Origin': allowOrigin,
		'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		Vary: 'Origin'
	};
}

export const OPTIONS: RequestHandler = async ({ request }) => {
	return new Response(null, {
		status: 204,
		headers: corsHeaders(request.headers.get('origin'))
	});
};

export const GET: RequestHandler = async ({ request }) => {
	return json(
		{ error: 'GET method not allowed. Use POST /api/scan with JSON body: { "barcode": "..." }.' },
		{
			status: 405,
			headers: {
				...corsHeaders(request.headers.get('origin')),
				Allow: 'POST, OPTIONS'
			}
		}
	);
};

function normalizeText(value: unknown) {
	if (value === null || value === undefined) return '';
	let text = String(value);
	
	// Strip HTML tags and common markup
	text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
	text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
	text = text.replace(/<!DOCTYPE[^>]*>/gi, '');
	text = text.replace(/<[^>]+>/g, ' ');
	
	// Remove HTML entities
	text = text.replace(/&nbsp;/g, ' ');
	text = text.replace(/&[a-z]+;/gi, ' ');
	text = text.replace(/&#\d+;/g, ' ');
	
	// Collapse whitespace
	text = text.replace(/\s+/g, ' ').trim();
	
	return text;
}

function stripGoogleTitleNoise(text: string) {
	if (!text) return '';
	return text.replace(/Google Search|Images|Videos|Shopping|Sign in|Settings|Skip to main content/gi, '');
}

function normalizeOcrText(text: string) {
	const cleaned = stripGoogleTitleNoise(normalizeText(text))
		.replace(/\u00a0/g, ' ')
		.replace(/[|]/g, ' ')
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/\s+/g, ' ')
		.trim();

	if (!cleaned) return '';

	return cleaned
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, ' ').replace(/\s*([,.;:!?])\s*/g, '$1 ').trim())
		.filter((line) => line && !/^(?:page \d+|\d+\/\d+|search results|results|ocr text)$/i.test(line))
		.join('\n')
		.trim();
}

function buildBrandAliasCandidates(rawBrand: string) {
	const normalized = normalizeText(rawBrand);
	if (!normalized) return [] as string[];

	const candidates = new Set<string>();
	const add = (value: string) => {
		const cleaned = normalizeText(value);
		if (!cleaned || isUnresolved(cleaned)) return;
		candidates.add(cleaned);
	};

	add(normalized);
	add(canonicalizeBrand(normalized));
	add(deriveBrandFromProductName(normalized));
	add(normalized.replace(/[™®]/g, '').trim());
	add(normalized.replace(/\s+(?:the|company|brand)$/i, '').trim());
	add(normalized.replace(/[^A-Za-z0-9&\s-]/g, ' ').replace(/\s+/g, ' ').trim());

	const tokens = normalized.split(/\s+/).filter(Boolean);
	if (tokens.length > 1) {
		add(tokens[0]);
		add(tokens.slice(0, 2).join(' '));
	}

	return [...candidates].slice(0, 12);
}

async function lookupAuthorityRegistryCompany(subject: string): Promise<PublicVerificationResult | null> {
	const candidates = buildBrandAliasCandidates(subject);
	if (candidates.length === 0) return null;

	const queries = [
		...candidates.slice(0, 4).flatMap((candidate) => [
			`site:find-and-update.company-information.service.gov.uk "${candidate}"`,
			`site:sec.gov/edgar "${candidate}"`,
			`site:opencorporates.com/company "${candidate}"`
		]),
		...candidates.slice(0, 2).map((candidate) => `${candidate} registered office headquarters`)
	];

	const results = (await Promise.all(
		queries.map((query) =>
			serperSearch(query).catch(() => ({ query, contextText: '', statusCode: 0, used: false, snippetCount: 0 }))
		)
		)) as SerperSearchResult[];

	const mergedContext = results
		.map((result) => result.compactContext || result.contextText || '')
		.filter(Boolean)
		.join('\n');

	if (!mergedContext) return null;

	const company = normalizeCompanyName(inferParentFromEvidence(mergedContext, subject) || extractBrandLeadFromMarketContext(mergedContext) || subject);
	const hqCountry = normalizeCountryCandidate(inferHqCountryFromEvidence(mergedContext, company || subject) || inferCountryFromText(mergedContext));
	const hasRegistrySignals = /(company number|registered office|incorporated|incorporation|legal entity|registry|companies house|edgar|opencorporates|head office|headquarters)/i.test(
		mergedContext
	);

	if (!company || !isStrongCompanyCandidate(company) || !hqCountry || !hasRegistrySignals) return null;

	return {
		company,
		hqCountry,
		website: '',
		source: 'Registry',
		score: 0.92,
		evidence: normalizeText(mergedContext).slice(0, 240)
	};
}

async function extractOcrTextFromImageSource(imageSource: string): Promise<string> {
	const cleanedSource = normalizeText(imageSource).replace(/\s+/g, '');
	if (!cleanedSource) return '';

	const dataUrl = /^https?:\/\//i.test(cleanedSource) || /^data:/i.test(cleanedSource)
		? cleanedSource
		: `data:image/jpeg;base64,${cleanedSource}`;

	const response = await fetch(dataUrl);
	if (!response.ok) return '';

	const bytes = Buffer.from(await response.arrayBuffer());
	const { createWorker } = await import('tesseract.js');
	const worker = await createWorker('eng', 1, {
		logger: () => undefined
	});

	try {
		const result = await worker.recognize(bytes);
		return normalizeOcrText(result.data.text || '');
	} finally {
		await worker.terminate();
	}
}

async function resolveCameraEvidence(input: ScanEvidenceInput) {
	const directText = normalizeOcrText(input.ocr_text || '');
	if (directText) {
		return { ocrText: directText, source: 'ocr_text' as const, prompt: '' };
	}

	const imageSource = normalizeText(input.image_data_url || input.image_base64 || input.image_url || '');
	if (!imageSource) {
		return {
			ocrText: '',
			source: null,
			prompt: 'Point the camera at the product label so OCR can read the package text.'
		};
	}

	if (imageSource.length > 6_000_000) {
		return {
			ocrText: '',
			source: null,
			prompt: 'Image is too large for OCR. Move the camera closer and retry with a tighter crop.'
		};
	}

	const ocrText = await withTimeout(extractOcrTextFromImageSource(imageSource).catch(() => ''), 8000, '');
	if (!ocrText) {
		return {
			ocrText: '',
			source: 'image' as const,
			prompt: 'OCR could not read the label. Point the camera closer to the product and retry.'
		};
	}

	return { ocrText, source: 'image' as const, prompt: '' };
}

function isValidBrandCandidate(candidate: string) {
	const c = normalizeText(candidate);
	if (!c) return false;
	const lower = c.toLowerCase();
	if (lower.length < 3 || lower.length > 60) return false;
	// Reject obviously generic tokens
	const blacklist = [
		'new',
		'best',
		'conditioner',
		'shampoo',
		'product',
		'pack',
		'set',
		'size',
		'oz',
		'ml',
		'bottle',
		'cup',
		'bar',
		'soap',
		'scent',
		'flavour',
		'flavor',
		'organic',
		'natural',
		'latest',
		'sale'
	];
	for (const b of blacklist) {
		if (lower === b) return false;
		if (lower.startsWith(b + ' ') || lower.endsWith(' ' + b) || lower.includes(' ' + b + ' ')) return false;
	}
	// Prefer multi-token proper nouns or mixed-case tokens
	const tokens = c.split(/\s+/);
	if (tokens.length === 1 && /^[a-z]+$/.test(lower)) return false;
	return true;
}

function regexCleaner(value: unknown) {
	if (value === null || value === undefined) return '';
	let s = String(value).trim();
	// Remove leading prose fragments like "the parent is", colons, dashes
	s = s.replace(/^\s*(the\s+)?(?:parent|company|is|is the|owned by|owned|ultimate parent|parent company|:|-)[:\s]*/i, '');
	// Trim non-alphanumeric characters from start/end
	s = s.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
	// Remove trailing punctuation and compress whitespace
	s = s.replace(/[.,;:\-\s]+$/g, '').replace(/\s+/g, ' ').trim();
	return s;
}
function containsAny(text: string, words: string[]) {
	const haystack = normalizeText(text).toLowerCase();
	return words.some((word) => haystack.includes(word));
}

function looksLikeRetailer(name: string) {
	return containsAny(name, RETAILER_TERMS);
}

function isPrivateLabelBrand(brand: string) {
	return containsAny(brand, PRIVATE_LABEL_TERMS);
}

function detectLikelyDomain(text: string): 'food' | 'electronics' | 'unknown' {
	if (containsAny(text, FOOD_KEYWORDS)) return 'food';
	if (containsAny(text, ELECTRONICS_KEYWORDS)) return 'electronics';
	return 'unknown';
}

function domainToCategory(domain: 'food' | 'electronics' | 'unknown') {
	if (domain === 'food') return 'Beverage/Food';
	if (domain === 'electronics') return 'Electronics';
	return 'Unresolved Category';
}

function hasDirectEvidenceForFlag(reason: string) {
	const normalized = normalizeText(reason).toLowerCase();
	if (!normalized) return false;
	return (
		normalized.includes('headquarter') ||
		normalized.includes('headquartered') ||
		normalized.includes('ownership') ||
		normalized.includes('owned') ||
		normalized.includes('manufacturing') ||
		normalized.includes('manufacturing site') ||
		normalized.includes('factory')
	);
}

function getGs1RegistrationPrefix(barcode: string) {
	const digits = normalizeText(barcode).replace(/\D/g, '');
	if (digits.length >= 3) return digits.slice(0, 3);
	return 'Unresolved Prefix';
}

function extractPhysicalOriginFromContext(contextText: string) {
	const normalized = normalizeText(contextText);
	const match = normalized.match(/made\s+in\s+([A-Za-z][A-Za-z\s-]{1,40})/i);
	if (!match?.[1]) return 'Unresolved Origin';
	return normalizeText(match[1].replace(/[.,;:].*$/, '')) || 'Unresolved Origin';
}

function extractKeyIndicators(text: string) {
	const normalized = normalizeText(text).toLowerCase();
	if (!normalized) return [] as string[];

	const candidates = ['co2', 'carbonator', 'sparkling', 'sparkling water', 'manufacturer', 'headquarters', 'factory', 'plant'];

	return candidates.filter((token) => normalized.includes(token)).slice(0, 8);
}

function toVerificationSources(
	sources: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'>
): Array<'OFF' | 'Serper' | 'Internal'> {
	const mapped: Array<'OFF' | 'Serper' | 'Internal'> = [];
	if (sources.includes('OFF_API')) mapped.push('OFF');
	if (sources.includes('Search_Scrape')) mapped.push('Serper');
	if (sources.includes('Internal_Knowledge')) mapped.push('Internal');
	return mapped.length > 0 ? mapped : (['Internal'] as Array<'OFF' | 'Serper' | 'Internal'>);
}

function randomItem<T>(items: T[]) {
	return items[Math.floor(Math.random() * items.length)];
}

async function applyJitterDelay() {
	const delayMs = JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1));
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function containsManufacturerSignals(text: string) {
	return containsAny(text, ['manufacturer', 'headquarters', 'factory']);
}

function isUnresolved(value: string | undefined | null) {
	const v = normalizeText(value).toLowerCase();
	if (!v) return true;
	return /unresolved|unknown|n\/?a|n.a.|none|null|undefined/.test(v);
}

function canonicalizeBrand(rawBrand: string) {
	const normalized = normalizeText(rawBrand);
	if (!normalized) return '';
	return normalized;
}

function titleCase(s: string) {
	return s
		.toLowerCase()
		.split(/\s+/)
		.map((w) => (w.length > 1 ? w[0].toUpperCase() + w.slice(1) : w.toUpperCase()))
		.join(' ')
		.trim();
}

function normalizeCompanyName(raw?: string) {
	if (!raw) return '';
	let s = normalizeText(raw);
	if (!s) return '';

	// Remove obvious slug prefixes and organizational identifiers
	s = s.replace(/^org[-_:\s]+/i, '');
	s = s.replace(/^company[-_:\s]+/i, '');
	s = s.replace(/^(the\s+)/i, '');

	// Remove trailing tokens that are not part of a proper company name
	s = s.replace(/( - | \| ).*$/, '');
	s = s.replace(/(commerciale|comercial|llc|ltd|sarl|sa|gmbh|inc|nv|spa|plc)\b.*$/i, '$1');

	// Replace non-alphanumeric with spaces, collapse whitespace
	s = s.replace(/[^A-Za-z0-9&\s.\-']/g, ' ');
	s = s.replace(/[-_/]+/g, ' ');
	s = s.replace(/\s+/g, ' ').trim();

	// Remove article-like noise or very long sluggy strings
	if (/^(https?:\/\/|www\.|cdn\.)/i.test(s)) return '';
	if (s.length > 120) return '';
	if (inferCountryFromText(s) && normalizeText(s).toLowerCase() === inferCountryFromText(s).toLowerCase()) return '';

	// Simple blacklist for noisy patterns
	const hasCorporateSuffix = /\b(inc|ltd|limited|llc|plc|corp|corporation|company|group|spa|s\.a\.|gmbh|nv|holdings|industries|international)\b/i.test(s);
	if (/\b(cnn|the following|list of products|shopping|results|google|where an item was manufactured|number tells you)\b/i.test(s)) return '';
	if (/\b(by the|official site|product page|barcode|search results)\b/i.test(s)) return '';
	if (/\b(drink|biscuits|dates|chocolate|cereal|cookie|soda|juice|water|snack|food)\b/i.test(s) && !hasCorporateSuffix) return '';

	// Title-case for readability
	try {
		return titleCase(s);
	} catch {
		return s;
	}
}

function buildOfficialSiteCandidates(subject: string, websiteHint?: string, wikidataWebsite?: string) {
	const candidates = new Set<string>();
	const addWebsite = (value: string) => {
		const cleaned = normalizeText(value);
		if (!cleaned) return;
		const normalized = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned.replace(/^\/+/, '')}`;
		candidates.add(normalized.replace(/\/$/, ''));
	};

	const addDomain = (domain: string) => {
		const cleaned = normalizeText(domain).toLowerCase().replace(/[^a-z0-9.-]/g, '');
		if (!cleaned) return;
		addWebsite(cleaned);
		if (!cleaned.startsWith('www.')) {
			addWebsite(`www.${cleaned}`);
		}
	};

	addWebsite(websiteHint || '');
	addWebsite(wikidataWebsite || '');

	const company = normalizeCompanyName(subject);
	if (!company) return [...candidates];

	const suffixStopWords = new Set([
		'group',
		'holding',
		'holdings',
		'company',
		'co',
		'corp',
		'corporation',
		'limited',
		'ltd',
		'inc',
		'international',
		'industries',
		'manufacturing',
		'food',
		'foods',
		'beverage',
		'beverages',
		'packaging',
		'enterprises'
	]);
	const noiseWords = new Set(['the', 'and', 'of', 'for', 'a', 'an', 'in']);
	const tokens = company
		.toLowerCase()
		.split(/\s+/)
		.filter((token) => token && !noiseWords.has(token));
	const rootTokens = tokens.filter((token) => !suffixStopWords.has(token));
	const bases = [
		rootTokens[0] || '',
		rootTokens.join(''),
		tokens[0] || '',
		company.toLowerCase().replace(/\s+/g, '')
	].filter((value, index, all) => value && all.indexOf(value) === index);

	for (const base of bases) {
		const compact = base.replace(/[^a-z0-9]/g, '');
		if (!compact) continue;
		const tlds = ['com', 'net', 'org', 'co', 'biz', 'info', 'io', 'bd', 'com.bd', 'net.bd', 'co.bd', 'com.au', 'co.uk', 'uk'];
		for (const tld of tlds) {
			addDomain(`${compact}.${tld}`);
		}
		addDomain(`${compact}group.com`);
		addDomain(`${compact}group.net`);
		addDomain(`${compact}group.com.bd`);
		// also try hyphenated variants: e.g., akij-group
		addDomain(`${compact}-group.com`);
		addDomain(`${compact}-group.net`);
	}

	return [...candidates];
}

function isGenericBarcodeCountryNoise(text: string) {
	const normalized = normalizeText(text).toLowerCase();
	if (!normalized) return false;
	return /\b(barcode country code|country code table|country prefix|gs1|gtin|ean country code|upc barcode guide|barcode lookup|verified by gs1|barcode us|countrychecker|barcode country codes|how to identify a product's origin from its barcode)\b/i.test(normalized);
}

function isStrongCompanyCandidate(candidate: string) {
	const normalized = normalizeCompanyName(candidate);
	if (!normalized) return false;
	if (isUnresolved(normalized)) return false;
	if (inferCountryFromText(normalized)) return false;
	const lower = normalized.toLowerCase();
	if (/\b(cnn|google search|shopping|results?|the following|barcode lookup|country code|country prefix)\b/i.test(lower)) return false;
	return /\b(company|co\.?|group|holdings?|limited|ltd|inc|llc|plc|corp|corporation|sa|s\.a\.|gmbh|nv|spa|industries|international|beverage|beverages|foods?|enterprises|manufacturing|packaging)\b/i.test(lower);
}

function extractBrandLeadFromMarketContext(contextText: string) {
	// Strip known Google UI/title noise before processing
	const cleaned = stripGoogleTitleNoise(contextText || '');
	const lines = cleaned
		.split('\n')
		.map((line) => normalizeText(line))
		.filter(Boolean);
	for (const line of lines) {
		const title = line.match(/^\[\d+\]\s*([^:|]{2,80})/)?.[1];
		const candidate = normalizeText(title || line.split('::')[0])
			.replace(/\s*\([^)]*\)/g, '')
			.replace(/\s*[-|].*$/, '')
			.trim();
		if (!isValidBrandCandidate(candidate)) continue;
		if (!candidate) continue;
		if (/^https?:\/\//i.test(candidate)) continue;
		if (/barcode|product|official|company/i.test(candidate) && candidate.length < 10) continue;
		return canonicalizeBrand(candidate);
	}
	return '';
}

function inferParentFromEvidence(contextText: string, brandHint?: string) {
	const normalized = normalizeText(contextText);
	const brandToken = normalizeText(brandHint || '').toLowerCase();
	const lines = normalized
		.split('\n')
		.map((line) => normalizeText(line))
		.filter(Boolean);
	const candidateLines = brandToken
		? lines.filter((line) => line.toLowerCase().includes(brandToken))
		: lines;
	const searchSpace = candidateLines.length > 0 ? candidateLines.join('\n') : normalized;
	const patterns = [
		/^([A-Z][A-Za-z0-9&.,'-]{1,50}(?:\s+[A-Z][A-Za-z0-9&.,'-]{1,50}){0,4})\s+(?:is|was|are|were|has|have|buying|launching|announces|introduces|creates|makes|made|produces|acquires|purchases|develops)\b/i,
		/(?:parent company|owned by|acquired by|manufacturer is|manufactured by|produced by|made by|imported by|distributed by|licensed by|packed by|packed for|manufactured for|distributed for)\s+([A-Z][A-Za-z0-9&.,'-\s]{2,80})/i,
		/([A-Z][A-Za-z0-9&.,'-\s]{2,80})\s+(?:owns|acquired|is the parent company of)/i
	];
	for (const pattern of patterns) {
		const match = searchSpace.match(pattern);
		const value = normalizeText(match?.[1]);
		if (value && !/unresolved|unknown|n\/a/i.test(value) && isStrongCompanyCandidate(value)) {
			return value.replace(/[.;,:]$/, '');
		}
	}
	return '';
}

function companyValueHasEvidenceSupport(value: string, contextText: string, anchor?: string) {
	const normalizedValue = normalizeCompanyName(value);
	if (!normalizedValue || isUnresolved(normalizedValue) || !isStrongCompanyCandidate(normalizedValue)) return false;

	const anchorText = normalizeText(anchor || '');
	const lines = splitEvidenceLines(contextText);
	for (const line of lines) {
		const lower = line.toLowerCase();
		if (!lower.includes(normalizedValue.toLowerCase())) continue;
		if (anchorText && lineMentionsAnchor(line, anchorText)) return true;
		if (/(owned by|parent company|manufacturer is|manufactured by|acquired by|produced by|made by|imported by|distributed by|licensed by|packed by|packed for|manufactured for|distributed for|company|group|holding|headquarters|\bhq\b|brand|owner)/i.test(line)) {
			return true;
		}
	}

	return false;
}

function companyHasHqEvidence(value: string, contextText: string, anchor?: string) {
	const normalizedValue = normalizeCompanyName(value);
	if (!normalizedValue || isUnresolved(normalizedValue)) return false;
	const anchorText = normalizeText(anchor || '');
	const lines = splitEvidenceLines(contextText);
	for (const line of lines) {
		const lower = line.toLowerCase();
		if (!lower.includes(normalizedValue.toLowerCase())) continue;
		// Require explicit HQ language together with the company mention (stronger signal)
		if (/(headquarters|head office|headquartered|registered office|global hq|corporate headquarters|\bhq\b|based in|located in)/i.test(line)) {
			if (anchorText) {
				if (lineMentionsAnchor(line, anchorText)) return true;
			} else {
				return true;
			}
		}
	}
	return false;
}

function inferOriginCountryFromEvidence(contextText: string, anchor?: string) {
	return resolveCountryFromEvidence(contextText, anchor, 'origin');
}

function normalizeCountryCandidate(value?: string | null) {
	return inferCountryFromText(value || '');
}

function looksLikeProductLabel(value: string) {
	const text = normalizeText(value).toLowerCase();
	if (!text) return false;
	return /\b(drink|biscuits|dates|chocolate|cereal|cookie|soda|juice|water|snack|food|taste|original)\b/i.test(text);
}

function deriveBrandFromProductName(productName: string) {
	const cleaned = normalizeText(productName)
		.replace(/\s*\([^)]*\)/g, '')
		.replace(/\s*[-|].*$/, '')
		.trim();
	if (!cleaned) return '';
	const firstToken = cleaned.split(/\s+/)[0] || '';
	if (!firstToken) return '';
	if (!/^[A-Z][A-Za-z0-9&'-]{1,30}$/.test(firstToken)) return '';
	if (looksLikeProductLabel(firstToken)) return '';
	if (/^(barcode|lookup|wikipedia|wikidata|google|official|search)$/i.test(firstToken)) return '';
	return firstToken;
}

function lineMentionsAnchor(line: string, anchor: string) {
	const normalizedAnchor = normalizeText(anchor).toLowerCase();
	if (!normalizedAnchor) return false;
	const anchorTokens = normalizedAnchor.split(/\s+/).filter((token) => token.length > 2);
	if (anchorTokens.length === 0) return false;
	const normalizedLine = normalizeText(line).toLowerCase();
	return anchorTokens.some((token) => normalizedLine.includes(token));
}

function splitEvidenceLines(contextText: string) {
	return normalizeText(contextText)
		.split('\n')
		.map((line) => normalizeText(line))
		.filter((line) => line && !isGenericBarcodeCountryNoise(line));
}

function resolveCountryFromEvidence(contextText: string, anchor?: string, mode: 'origin' | 'hq' = 'origin') {
	const normalized = normalizeText(contextText);
	if (!normalized) return '';

	const anchorText = normalizeText(anchor || '');
	const lines = splitEvidenceLines(normalized);
	let bestCountry = '';
	let bestScore = 0;
	const minimumScore = mode === 'hq' ? 5 : 3;

	for (const line of lines) {
		const country = inferCountryFromText(line);
		if (!country) continue;

		const lower = line.toLowerCase();
		let score = 0;

		if (mode === 'origin') {
			if (/(country of origin|origin|made in|product of|manufactured in|produced in|packed in)/i.test(lower)) score += 5;
			if (/(manufactured by|produced by|made by)/i.test(lower)) score += 2;
		} else {
			if (/(headquarters|head office|headquartered|global hq|corporate headquarters|\bhq\b)/i.test(lower)) score += 5;
			if (/(based in|located in)/i.test(lower)) score += 2;
		}

		if (anchorText && lineMentionsAnchor(line, anchorText)) score += 3;
		if (lines.length <= 3) score += 1;
		if (line.split(/\s+/).length <= 12) score += 1;

		if (score < minimumScore) continue;
		if (score > bestScore) {
			bestScore = score;
			bestCountry = country;
		}
	}

	return bestCountry;
}

function inferHqCountryFromEvidence(contextText: string, anchor?: string) {
	return resolveCountryFromEvidence(contextText, anchor, 'hq');
}

async function runSupplementalCorporateSearch(subject: string, barcode: string) {
	const cleanedSubject = normalizeText(subject);
	if (!cleanedSubject || isUnresolved(cleanedSubject)) {
		return { contextText: '', queries: [] as string[] };
	}

	const queries = [
		`${cleanedSubject} manufacturer company`,
		`${cleanedSubject} parent company headquarters`,
		`${cleanedSubject} country of origin`,
		`${cleanedSubject} made in`
	];
	console.log(`🔎 [SUPPLEMENTAL_SEARCH] barcode=${barcode} subject=${cleanedSubject}`);

	const results = (await Promise.all(
		queries.map((query) =>
			serperSearch(query).catch(() => ({ query, contextText: '', statusCode: 0, used: false, snippetCount: 0 }))
		)
	)) as SerperSearchResult[];

	const mergedContext = results.map((result) => result.compactContext || result.contextText || '').filter(Boolean).join('\n');
	if (mergedContext) {
		console.log(`📡 [SUPPLEMENTAL_SEARCH] snippets=${results.reduce((sum, result) => sum + (result.snippetCount || 0), 0)}`);
	}

	return { contextText: mergedContext, queries };
}

async function lookupWikidataCompany(subject: string): Promise<PublicVerificationResult | null> {
	const cleanedSubject = normalizeText(subject);
	if (!cleanedSubject || isUnresolved(cleanedSubject)) return null;

	const query = `
SELECT ?item ?itemLabel ?website ?countryLabel ?hqLabel WHERE {
  VALUES ?searchTerm { "${cleanedSubject.replace(/"/g, '\\"')}" }
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "EntitySearch".
    bd:serviceParam wikibase:endpoint "www.wikidata.org".
    bd:serviceParam mwapi:search ?searchTerm.
    bd:serviceParam mwapi:language "en".
    ?item wikibase:apiOutputItem mwapi:item.
  }
  OPTIONAL { ?item wdt:P856 ?website. }
  OPTIONAL { ?item wdt:P17 ?country. }
  OPTIONAL { ?item wdt:P159 ?hq. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 1`.trim();

	try {
		const response = await fetch('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), {
			headers: buildFetchHeaders({ Accept: 'application/sparql-results+json' })
		});
		if (!response.ok) return null;
		const payload = (await response.json()) as {
			results?: {
				bindings?: Array<{
					itemLabel?: { value?: string };
					website?: { value?: string };
					countryLabel?: { value?: string };
					hqLabel?: { value?: string };
				}>;
			};
		};
		const binding = payload.results?.bindings?.[0];
		if (!binding) return null;
		const company = normalizeCompanyName(binding.itemLabel?.value || '') || '';
		const website = normalizeText(binding.website?.value || '');
		const hqCountry = inferCountryFromText(binding.hqLabel?.value || binding.countryLabel?.value || '');
		if (!company || !isStrongCompanyCandidate(company)) return null;
		const score = hqCountry ? 0.9 : 0.75;
		return {
			company,
			hqCountry: hqCountry || 'Unresolved HQ Country',
			website,
			source: 'Wikidata',
			score,
			evidence: `Wikidata company=${company} website=${website || 'n/a'} hq=${hqCountry || 'n/a'}`
		};
	} catch {
		return null;
	}
}

async function probeOfficialSite(websiteUrl: string, anchor?: string): Promise<PublicVerificationResult | null> {
	const cleanedUrl = normalizeText(websiteUrl);
	if (!cleanedUrl || !/^https?:\/\//i.test(cleanedUrl)) return null;

	const candidates = [cleanedUrl, `${cleanedUrl.replace(/\/$/, '')}/about`, `${cleanedUrl.replace(/\/$/, '')}/contact`];
	for (const candidate of candidates) {
		try {
			let response: Response | null = null;
			try {
				response = await fetch(candidate, { headers: buildFetchHeaders(), redirect: 'follow' });
				if (!response.ok) {
					// Try http fallback for sites that don't like https
					if (/^https:\/\//i.test(candidate)) {
						const httpCandidate = candidate.replace(/^https:/i, 'http:');
						try {
							response = await fetch(httpCandidate, { headers: buildFetchHeaders(), redirect: 'follow' });
						} catch {
							response = null;
						}
						if (!response || !response.ok) continue;
					} else continue;
				}
			} catch {
				// Try http variant if https failed with network error
				if (/^https:\/\//i.test(candidate)) {
					const httpCandidate = candidate.replace(/^https:/i, 'http:');
					try {
						response = await fetch(httpCandidate, { headers: buildFetchHeaders(), redirect: 'follow' });
					} catch {
						response = null;
					}
				}
				if (!response) continue;
			}
			const html = await response.text();
			const $ = cheerio.load(html);
			const ldJson = $('script[type="application/ld+json"]')
				.map((_, element) => normalizeText($(element).text()))
				.get()
				.join('\n');
			const pageText = normalizeText([
				$('title').text(),
				$('meta[name="description"]').attr('content') || '',
				$('body').text(),
				ldJson
			].join('\n'));
			const company = normalizeCompanyName(
				$('meta[property="og:site_name"]').attr('content') || $('title').text() || anchor || cleanedUrl
			);
			const hqCountry = inferHqCountryFromEvidence(pageText, anchor || company) || inferCountryFromText(pageText);
			if (!company || !isStrongCompanyCandidate(company)) continue;
			if (!hqCountry) continue;
			return {
				company,
				hqCountry,
				website: candidate,
				source: 'OfficialSite',
				score: 0.8,
				evidence: normalizeText(pageText).slice(0, 240)
			};
		} catch {
			continue;
		}
	}

	return null;
}

async function runPublicVerificationPass(subject: string, websiteHint?: string) {
	const wikidata = await lookupWikidataCompany(subject);
	if (wikidata) {
		console.log(`🛰️ [PUBLIC_VERIFY] Wikidata company=${wikidata.company} hq=${wikidata.hqCountry}`);
		if (!isUnresolved(wikidata.hqCountry) && !isUnresolved(wikidata.company)) return wikidata;
	}

	const registry = await lookupAuthorityRegistryCompany(subject);
	if (registry) {
		console.log(`🏛️ [PUBLIC_VERIFY] Registry company=${registry.company} hq=${registry.hqCountry}`);
		if (!isUnresolved(registry.hqCountry) && !isUnresolved(registry.company)) return registry;
	}

	const website = normalizeText(websiteHint || wikidata?.website || '');
	if (website) {
		const official = await probeOfficialSite(website, subject);
		if (official) {
			console.log(`🔎 [PUBLIC_VERIFY] OfficialSite company=${official.company} hq=${official.hqCountry}`);
			return official;
		}
	}

	const guessedCandidates = buildOfficialSiteCandidates(subject, website, wikidata?.website || '');
	for (const candidate of guessedCandidates) {
		if (!candidate || candidate === website) continue;
		console.log(`🔎 [PUBLIC_VERIFY] Guessing official site candidate=${candidate}`);
		const official = await probeOfficialSite(candidate, subject);
		if (official) {
			console.log(`🔎 [PUBLIC_VERIFY] OfficialSite guess hit company=${official.company} hq=${official.hqCountry}`);
			return official;
		}
	}

	return registry || wikidata;
}

function pickEvidenceSnippet(contextText: string, token?: string) {
	const lines = contextText
		.split('\n')
		.map((line) => normalizeText(line))
		.filter(Boolean);
	if (lines.length === 0) return 'No snippet evidence available.';
	if (token) {
		const hit = lines.find((line) => line.toLowerCase().includes(token.toLowerCase()));
		if (hit) return hit;
	}
	return lines[0];
}

function isBarcodePlaceholder(value: string | undefined | null) {
	if (!value) return true;
	const v = normalizeText(value).toLowerCase();
	return /^barcode\s*\d{6,}|^unresolved/i.test(v) || /barcode\s+\d+/.test(v);
}

function extractProductIdentityFromEvidence(merged: string, market: string, deep: string, registry: string) {
	const raw = [market, deep, registry, merged].filter(Boolean).join('\n');
	const text = stripGoogleTitleNoise(raw).replace(/\s+/g, ' ');
	const result: { productName?: string; brand?: string; sourceLine?: string } = {};

	// Try a targeted brand+product capture for visible brand tokens (evidence-driven)
	const brandMatch = text.match(/\b([A-Z][a-zA-Z0-9&]{2,60}(?:\s+[A-Z][a-zA-Z0-9&]{2,60})?)\b(?=[\s\S]{0,80}?(?:product|maker|soda|machine|device|jet|sparkling))/i);
	if (brandMatch) {
		const cand = normalizeText(brandMatch[1]);
		if (isValidBrandCandidate(cand)) result.brand = cand;
	}

	// Look specifically for multi-word product names around capitalized brand tokens (evidence-derived)
	const productPattern = text.match(/([A-Z][A-Za-z0-9-]{2,40}(?:\s+[A-Z][A-Za-z0-9-]{2,40}){0,5})/g);
	if (productPattern && productPattern.length > 0) {
		// Prefer lines with known product-related keywords
		const candidate = productPattern.find((p) => /soda|maker|jet|machine|sparkling|carbonator|cylinder/i.test(p));
		const pick = normalizeText(candidate || productPattern[0]);
		// Avoid single-token generic picks
		if (pick && pick.split(/\s+/).length > 1) result.productName = pick;
	}

	return result;
}

function parseOffBrandDeep(product: OpenFoodFactsProduct | null) {
	if (!product) {
		return { brand: '', source: '', parsed: false };
	}

	const fromBrands = normalizeText(product.brands)
		.split(',')
		.map((item) => normalizeText(item))
		.find(Boolean);
	if (fromBrands) {
		const canonical = canonicalizeBrand(fromBrands);
		console.log(`📦 [PARSED] OFF nested brand source=brands value=${canonical}`);
		return { brand: canonical, source: 'brands', parsed: true };
	}

	const fromManufacturer = normalizeText(product.manufacturer_name);
	if (fromManufacturer) {
		const canonical = canonicalizeBrand(fromManufacturer);
		console.log(`📦 [PARSED] OFF nested brand source=manufacturer_name value=${canonical}`);
		return { brand: canonical, source: 'manufacturer_name', parsed: true };
	}

	const tags = Array.isArray(product.brands_tags)
		? product.brands_tags
		: normalizeText(product.brands_tags)
			? [normalizeText(product.brands_tags)]
			: [];
	const fromTags = tags
		.map((tag) => normalizeText(tag).replace(/^[a-z]{2}:/i, ''))
		.map((tag) => normalizeText(tag.replace(/[-_]/g, ' ')))
		.find(Boolean);
	if (fromTags) {
		const canonical = canonicalizeBrand(fromTags);
		console.log(`📦 [PARSED] OFF nested brand source=brands_tags value=${canonical}`);
		return { brand: canonical, source: 'brands_tags', parsed: true };
	}

	const fromOwnerName = normalizeText(product.owner_name);
	if (fromOwnerName) {
		const canonical = canonicalizeBrand(fromOwnerName);
		console.log(`📦 [PARSED] OFF nested brand source=owner_name value=${canonical}`);
		return { brand: canonical, source: 'owner_name', parsed: true };
	}

	const fromOwner = normalizeText(product.owner);
	if (fromOwner) {
		const canonical = canonicalizeBrand(fromOwner);
		console.log(`📦 [PARSED] OFF nested brand source=owner value=${canonical}`);
		return { brand: canonical, source: 'owner', parsed: true };
	}

	return { brand: '', source: '', parsed: false };
}

function resolveFingerprintProfile(userAgent: string) {
	const ua = normalizeText(userAgent);
	const chromeVersion = ua.match(/Chrome\/([\d.]+)/)?.[1] ?? '124.0.0.0';
	const chromeMajor = chromeVersion.split('.')[0] || '124';
	const isChrome = /Chrome\//i.test(ua) && !/Safari\/605\.1\.15/i.test(ua);
	const isMobile = /iPhone|Android|Mobile/i.test(ua);
	const platform = /Windows/i.test(ua)
		? 'Windows'
		: /Macintosh|Mac OS X/i.test(ua)
			? 'macOS'
			: /Linux|X11/i.test(ua)
				? 'Linux'
				: isMobile
					? 'iOS'
					: 'Unknown';

	const secChUa = isChrome
		? `"Chromium";v="${chromeMajor}", "Not.A/Brand";v="24", "Google Chrome";v="${chromeMajor}"`
		: '"Not.A/Brand";v="99", "Safari";v="17", "WebKit";v="605"';

	return {
		secChUa,
		platform,
		secChUaMobile: isMobile ? '?1' : '?0'
	};
}

function buildSourceHierarchy(args: {
	serperPrimary: boolean;
	scraperAvailable: boolean;
	offAvailable: boolean;
	internalFallback: boolean;
}) {
	const layers: string[] = [];
	if (args.serperPrimary) layers.push('Serper Primary');
	if (args.scraperAvailable) layers.push('Scraper Secondary');
	if (args.offAvailable) layers.push('Registry OFF');
	if (args.internalFallback) layers.push('Internal Fallback');
	return layers.length > 0 ? layers.join(' > ') : 'Internal Fallback';
}

function buildEvidenceBundle(args: {
	barcode: string;
	offProduct: OpenFoodFactsProduct | null;
	offBrand: string;
	offOriginCountry: string;
	offCategory: string;
	offParentCompany: string;
	publicVerification: PublicVerificationResult | null;
	searchContext: string;
	deepScrape: string;
	hqPulse: string;
	truthBundleBlock: string;
}): EvidenceBundle {
	const productName =
		normalizeText(args.offProduct?.product_name) ||
		extractProductIdentityFromEvidence(
			[args.searchContext, args.deepScrape, args.truthBundleBlock, args.hqPulse].filter(Boolean).join('\n'),
			args.searchContext,
			args.deepScrape,
			args.truthBundleBlock
		).productName ||
		`Unresolved Product ${args.barcode}`;
	const sources = [
		args.offProduct ? 'OFF' : '',
		args.publicVerification?.source ? `Public:${args.publicVerification.source}` : '',
		args.searchContext ? 'Serper' : '',
		args.deepScrape ? 'Scraper' : '',
		args.hqPulse ? 'HQ-Query' : ''
	].filter(Boolean);

	return {
		product_name: productName,
		brand: normalizeText(args.offBrand) || 'Unresolved Brand',
		parent_company: normalizeText(args.offParentCompany || args.publicVerification?.company || '') || 'Unresolved Parent',
		parent_hq_country:
			normalizeText(args.publicVerification?.hqCountry || '') || 'Unresolved HQ Country',
		origin_country: normalizeText(args.offOriginCountry) || 'Unresolved Origin',
		category: normalizeText(args.offCategory) || 'Unresolved Category',
		sources
	};
}

function buildScrapeHeaders() {
	const randomizedUserAgent = randomItem(STEALTH_USER_AGENTS);
	const fingerprint = resolveFingerprintProfile(randomizedUserAgent);
	console.log(
		`🕵️ [FINGERPRINT] Showing matched headers. UA=${randomizedUserAgent} Sec-CH-UA=${fingerprint.secChUa} Sec-CH-UA-Platform=${fingerprint.platform}`
	);
	return {
		'User-Agent': randomizedUserAgent,
		'Sec-CH-UA': fingerprint.secChUa,
		'Sec-CH-UA-Platform': `"${fingerprint.platform}"`,
		'Sec-CH-UA-Mobile': fingerprint.secChUaMobile,
		Accept: BROWSER_ACCEPT_HEADER,
		'Accept-Language': randomItem(STEALTH_ACCEPT_LANGUAGES),
		'Sec-Fetch-Mode': 'navigate',
		'Sec-Fetch-Site': 'none',
		Referer: randomItem(STEALTH_REFERERS)
	};
}

function buildFetchHeaders(extraHeaders?: Record<string, string>) {
	return {
		...buildScrapeHeaders(),
		...extraHeaders
	};
}

function extractJsonObject(rawText: string) {
	const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
	const candidate = fenced ?? rawText;
	const start = candidate.indexOf('{');
	const end = candidate.lastIndexOf('}');

	if (start === -1 || end === -1 || end < start) {
		return candidate;
	}

	return candidate.slice(start, end + 1);
}

function summarizeSerperPayload(payload: SerperPayload) {
	const kg = payload.knowledgeGraph;
	const kgLine = [kg?.title, kg?.type, kg?.description].map((v) => normalizeText(v)).filter(Boolean).join(' | ');
	const organicLines = (payload.organic || [])
		.map((item, idx) => {
			const title = normalizeText(item.title);
			const snippet = normalizeText(item.snippet);
			const link = normalizeText(item.link);
			return `[${idx + 1}] ${title}${snippet ? ` :: ${snippet}` : ''}${link ? ` :: ${link}` : ''}`;
		})
		.filter(Boolean);

	return [kgLine, ...organicLines].filter(Boolean).join('\n');
}

async function serperSearch(query: string) {
	const apiKey = dynamicEnv.SEARCH_API_KEY || SEARCH_API_KEY;
	if (!apiKey) {
		console.warn('⚠️ Serper API key missing at runtime (dynamicEnv and static).');
		return { query, contextText: '', statusCode: 0, used: false, snippetCount: 0 };
	}

	await applyJitterDelay();

	const response = await fetch(SERPER_API_URL, {
		method: 'POST',
		headers: {
			'X-API-KEY': apiKey,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ q: query, gl: 'us', hl: 'en', num: 10 })
	});

	if (!response.ok) {
		console.warn(`📡 [SERPER] ${query} -> status ${response.status}`);
		return { query, contextText: '', statusCode: response.status, used: false, snippetCount: 0 };
	}

	const payload = (await response.json()) as SerperPayload;
	const contextText = summarizeSerperPayload(payload);
	const cleanSnippet = (text: string) => (text || '').replace(/Google Search|Images|Videos|Shopping|Sign in|Settings|Skip to main content/gi, '').trim();
	const compactContext = (payload.organic || [])
		.map((r) => `${cleanSnippet(normalizeText(r.title))} ${cleanSnippet(normalizeText(r.snippet))}`.trim())
		.filter(Boolean)
		.join(' | ');
	const snippetCount = payload.organic?.length ?? 0;
	if (snippetCount > 0) {
		console.log(`📡 [SERPER] query=${query} snippets=${snippetCount} chars=${contextText.length}`);
	}
	return {
		query,
		contextText,
		compactContext,
		statusCode: response.status,
		used: Boolean(contextText),
		snippetCount
	};
}

async function serperPrimarySearchWithRetry(barcode: string): Promise<SerperPrimaryResult> {
	const primaryQuery = `${barcode} official manufacturer parent company`;
	const primary = await serperSearch(primaryQuery).catch(() => ({
		query: primaryQuery,
		contextText: '',
		statusCode: 0,
		used: false,
		snippetCount: 0
	}));

	if ((primary.snippetCount ?? 0) > 0 || primary.statusCode === 429) {
		const out = {
			result: primary,
			retried: false,
			primaryQuery,
			retryQuery: null as string | null,
			firstAttemptSnippets: primary.snippetCount ?? 0
		};
		return out;
	}

	// Strengthened retry: use an explicit product-brand-manufacturer query when primary returns 0 snippets
	const retryQuery = `product brand manufacturer for barcode ${barcode}`;
	console.log(`🔁 [RETRY] 0 snippets on primary query; retrying with "${retryQuery}".`);
	const retry = await serperSearch(retryQuery).catch(() => ({
		query: retryQuery,
		contextText: '',
		statusCode: 0,
		used: false,
		snippetCount: 0
	}));

	if ((retry.snippetCount ?? 0) > 0 || retry.statusCode === 429 || retry.contextText) {
		const out = {
			result: retry,
			retried: true,
			primaryQuery,
			retryQuery,
			firstAttemptSnippets: primary.snippetCount ?? 0
		};
		// Return immediately when retry produced context to avoid data leak
		return out;
	}

	// Diagnostic logging: when both primary and retry are empty, persist raw Serper responses for debugging
	if ((primary.snippetCount ?? 0) === 0 && (retry.snippetCount ?? 0) === 0) {
		try {
			console.log('🔍 [SERPER_RAW] primary response (empty):', JSON.stringify(primary));
			console.log('🔍 [SERPER_RAW] retry response (empty):', JSON.stringify(retry));
		} catch {
			console.log('🔍 [SERPER_RAW] primary/retry response (could not stringify)');
		}
	}

	const fallbackQuery = `"${barcode}" product name brand manufacturer`;
	console.log(`🔁 [RETRY] Secondary empty-market search with "${fallbackQuery}".`);
	const fallback = await serperSearch(fallbackQuery).catch(() => ({
		query: fallbackQuery,
		contextText: '',
		statusCode: 0,
		used: false,
		snippetCount: 0
	}));

	// If fallback also returned empty, log the raw fallback response for diagnostics
	if ((fallback.snippetCount ?? 0) === 0) {
		try {
			console.log('🔍 [SERPER_RAW] fallback response (empty):', JSON.stringify(fallback));
		} catch {
			console.log('🔍 [SERPER_RAW] fallback response (empty; could not stringify)');
		}
	}

	return {
		result: fallback,
		retried: true,
		primaryQuery,
		retryQuery: fallbackQuery,
		firstAttemptSnippets: primary.snippetCount ?? 0
	};
}

async function performSerperHardSearch(barcode: string, offProduct: OpenFoodFactsProduct | null) {
	// Run three distinct Serper queries as a compensation strategy when OFF absent or 0 snippets
	const queries = [] as string[];
	queries.push(`${barcode} product details marketplace`);
	if (offProduct) {
		const offName = normalizeText(offProduct.product_name) || '';
		queries.push(`${offName} manufacturer brand official`);
		queries.push(`${offName} corporate headquarters country`);
	} else {
		queries.push(`${barcode} brand manufacturer`);
		queries.push(`${barcode} company headquarters country`);
	}

	const results = (await Promise.all(
		queries.map((q) =>
			serperSearch(q).catch(() => ({ query: q, contextText: '', statusCode: 0, used: false, snippetCount: 0 }))
		)
	)) as SerperSearchResult[];

	// Log Serper telemetry only when organic snippets present
	results.forEach((r, idx) => {
		if ((r.snippetCount ?? 0) > 0) console.log(`📡 [SERPER] HardSearch query=${queries[idx]} snippets=${r.snippetCount}`);
	});

	// Merge contexts into a compact organic stream: title + snippet joined by " | "
	// Prefer compactContext (title+snippet) when available; fall back to contextText
	const merged = results.map((r) => r.compactContext || r.contextText || '').filter(Boolean).join(' | ') || '';

	return { queries, results, mergedContext: merged };
}

function buildOpenFoodFactsContext(product: OpenFoodFactsProduct) {
	const parsed = parseOffBrandDeep(product);
	const countries = normalizeText(product.countries) || 'Unresolved Origin';
	const firstCountry = countries.split(',')[0].trim() || countries;
	const categories = normalizeText(product.categories) || 'Unresolved Category';
	const manufacturingPlaces = normalizeText(product.manufacturing_places) || 'Not specified';
	return [
		`OFF product_name: ${normalizeText(product.product_name) || 'Unresolved Product'}`,
		`OFF brand(s): ${parsed.brand || normalizeText(product.brand_owner) || normalizeText(product.manufacturer_name) || 'Unresolved Brand'}`,
		`OFF manufacturer: ${normalizeText(product.manufacturer_name) || 'Not specified'}`,
		`OFF owner: ${normalizeText(product.owner_name || product.owner) || 'Not specified'}`,
		`OFF generic_name: ${normalizeText(product.generic_name) || 'Unresolved Product Type'}`,
		`OFF categories: ${categories}`,
		`OFF primary_category: ${categories.split(',')[0].trim() || 'Unresolved'}`,
		`OFF countries: ${countries}`,
		`OFF primary_country: ${firstCountry}`,
		`OFF manufacturing_places: ${manufacturingPlaces}`,
		`OFF ingredients_text: ${normalizeText(product.ingredients_text)?.slice(0, 200) || 'Unresolved Ingredients'}`
	].join('\n');
}

function extractOffOriginCountry(product: OpenFoodFactsProduct | null) {
	if (!product) return 'Unresolved Origin';

	const madeInMatch = `${normalizeText(product.manufacturing_places)}\n${normalizeText(product.countries)}`.match(
		/(?:made|produced|manufactured|packed)\s+in\s+([A-Za-z][A-Za-z\s-]{1,60})/i
	);
	if (madeInMatch?.[1]) {
		const explicit = inferCountryFromText(madeInMatch[1]);
		if (explicit) return explicit;
	}

	for (const candidate of [product.manufacturing_places, product.countries]) {
		const primary = inferCountryFromText(candidate || '');
		if (primary) return primary;
	}

	return 'Unresolved Origin';
}

function extractOffCategory(product: OpenFoodFactsProduct | null) {
	if (!product) return 'Unresolved Category';

	const haystack = normalizeText(
		[product.categories, product.generic_name, product.product_name, product.ingredients_text]
			.filter(Boolean)
			.join(' ')
	).toLowerCase();

	if (!haystack) return 'Unresolved Category';
	if (/(beverage|drink|soda|juice|water|coffee|tea|milk|wine|beer|sparkling)/i.test(haystack)) return 'Beverage';
	if (/(personal care|cosmetic|beauty|shampoo|conditioner|soap|toothpaste|deodorant|skincare|skin care|hygiene)/i.test(haystack)) return 'Personal Care';
	if (/(household|cleaning|detergent|laundry|dish soap|dishwashing|surface cleaner|disinfect|air freshener)/i.test(haystack)) return 'Household';
	if (/(food|snack|cereal|chocolate|cookie|biscuits|cake|pasta|sauce|meat|cheese|fruit|vegetable|confection|dessert|breakfast)/i.test(haystack)) return 'Food';

	return 'Food';
}

function extractOffParentCompany(product: OpenFoodFactsProduct | null) {
	if (!product) return '';
	const productName = normalizeText(product.product_name);
	const productFirstToken = normalizeText(productName.split(/\s+/)[0] || '').toLowerCase();

	const candidates = [
		product.owner_name,
		product.owner,
		product.brand_owner,
		product.manufacturer_name,
		Array.isArray(product.brands_tags) ? product.brands_tags[0] : product.brands_tags,
		product.brands
	];

	for (const candidate of candidates) {
		const cleaned = regexCleaner(normalizeText(candidate));
		if (!cleaned || isUnresolved(cleaned)) continue;
		if (cleaned.length < 2 || cleaned.length > 120) continue;
		const cleanedLower = cleaned.toLowerCase();
		const hasCorporateSignal = /\b(company|group|holdings?|limited|ltd|inc|llc|plc|corp|corporation|sa|s\.a\.|gmbh|nv|spa|industries|international|beverage|beverages|foods?|enterprises|manufacturing|packaging)\b/i.test(cleanedLower);
		if (productFirstToken && cleanedLower === productFirstToken && !hasCorporateSignal) continue;
		if (productName && cleanedLower === productName.toLowerCase() && !hasCorporateSignal) continue;
		const normalized = normalizeCompanyName(cleaned);
		if (!normalized) continue;
		return normalized;
	}

	return '';
}

function inferCountryFromText(text: string) {
	const normalized = normalizeText(text);
	if (!normalized) return '';

	const aliases: Array<[RegExp, string]> = [
		[/\bUnited States\b/i, 'United States'],
		[/\bU\.S\.A\.??\b/i, 'United States'],
		[/\bUSA\b/i, 'United States'],
		[/\bU\.S\.?\b/i, 'United States'],
		[/\bUnited Kingdom\b/i, 'United Kingdom'],
		[/\bU\.K\.\b/i, 'United Kingdom'],
		[/\bUK\b/i, 'United Kingdom'],
		[/\bItaly\b/i, 'Italy'],
		[/\bFrance\b/i, 'France'],
		[/\bGermany\b/i, 'Germany'],
		[/\bBelgium\b/i, 'Belgium'],
		[/\bBelgique\b/i, 'Belgium'],
		[/\bNetherlands\b/i, 'Netherlands'],
		[/\bSpain\b/i, 'Spain'],
		[/\bSwitzerland\b/i, 'Switzerland'],
		[/\bDenmark\b/i, 'Denmark'],
		[/\bSweden\b/i, 'Sweden'],
		[/\bNorway\b/i, 'Norway'],
		[/\bFinland\b/i, 'Finland'],
		[/\bPoland\b/i, 'Poland'],
		[/\bAustria\b/i, 'Austria'],
		[/\bIreland\b/i, 'Ireland'],
		[/\bCanada\b/i, 'Canada'],
		[/\bMexico\b/i, 'Mexico'],
		[/\bBrazil\b/i, 'Brazil'],
		[/\bJapan\b/i, 'Japan'],
		[/\bChina\b/i, 'China'],
		[/\bIndia\b/i, 'India'],
		[/\bBangladesh\b/i, 'Bangladesh'],
		[/\bSaudi Arabia\b/i, 'Saudi Arabia'],
		[/\bKSA\b/i, 'Saudi Arabia'],
		[/\bUAE\b/i, 'United Arab Emirates'],
		[/\bUnited Arab Emirates\b/i, 'United Arab Emirates'],
		[/\bSouth Korea\b/i, 'South Korea'],
		[/\bRepublic of Korea\b/i, 'South Korea'],
		[/\bNorth Korea\b/i, 'North Korea'],
		[/\bCzech Republic\b/i, 'Czech Republic'],
		[/\bCzechia\b/i, 'Czech Republic'],
		[/\bTürkiye\b/i, 'Turkey'],
		[/\bTurkey\b/i, 'Turkey'],
		[/\bTaiwan\b/i, 'Taiwan'],
		[/\bHong Kong\b/i, 'Hong Kong'],
		[/\bSingapore\b/i, 'Singapore'],
		[/\bMalaysia\b/i, 'Malaysia'],
		[/\bThailand\b/i, 'Thailand'],
		[/\bPhilippines\b/i, 'Philippines'],
		[/\bIndonesia\b/i, 'Indonesia'],
		[/\bVietnam\b/i, 'Vietnam'],
		[/\bEgypt\b/i, 'Egypt'],
		[/\bSouth Africa\b/i, 'South Africa'],
		[/\bMorocco\b/i, 'Morocco'],
		[/\bNigeria\b/i, 'Nigeria'],
		[/\bKenya\b/i, 'Kenya'],
		[/\bArgentina\b/i, 'Argentina'],
		[/\bChile\b/i, 'Chile'],
		[/\bColombia\b/i, 'Colombia'],
		[/\bPeru\b/i, 'Peru'],
		[/\bTurkey\b/i, 'Turkey'],
		[/\bPakistan\b/i, 'Pakistan'],
		[/\bSri Lanka\b/i, 'Sri Lanka'],
		[/\bAustralia\b/i, 'Australia'],
		[/\bNew Zealand\b/i, 'New Zealand'],
		[/\bIsrael\b/i, 'Israel'],
		[/\bPortugal\b/i, 'Portugal'],
		[/\bGreece\b/i, 'Greece'],
		[/\bRomania\b/i, 'Romania'],
		[/\bHungary\b/i, 'Hungary'],
		[/\bCroatia\b/i, 'Croatia'],
		[/\bSlovakia\b/i, 'Slovakia'],
		[/\bBulgaria\b/i, 'Bulgaria'],
		[/\bSerbia\b/i, 'Serbia'],
		[/\bUkraine\b/i, 'Ukraine'],
		[/\bRussia\b/i, 'Russia'],
		[/\bKazakhstan\b/i, 'Kazakhstan'],
		[/\bIran\b/i, 'Iran'],
		[/\bIraq\b/i, 'Iraq'],
		[/\bJordan\b/i, 'Jordan'],
		[/\bLebanon\b/i, 'Lebanon'],
		[/\bQatar\b/i, 'Qatar'],
		[/\bKuwait\b/i, 'Kuwait'],
		[/\bOman\b/i, 'Oman'],
		[/\bBahrain\b/i, 'Bahrain'],
		[/\bDubai\b/i, 'United Arab Emirates'],
		[/\bAbu Dhabi\b/i, 'United Arab Emirates'],
		[/\bSharjah\b/i, 'United Arab Emirates'],
		[/\bRiyadh\b/i, 'Saudi Arabia'],
		[/\bJeddah\b/i, 'Saudi Arabia'],
		[/\bDoha\b/i, 'Qatar'],
		[/\bKuwait City\b/i, 'Kuwait'],
		[/\bEthiopia\b/i, 'Ethiopia'],
		[/\bGhana\b/i, 'Ghana'],
		[/\bTanzania\b/i, 'Tanzania'],
		[/\bZimbabwe\b/i, 'Zimbabwe'],
		[/\bMaldives\b/i, 'Maldives'],
		[/\bNepal\b/i, 'Nepal'],
		[/\bMyanmar\b/i, 'Myanmar'],
		[/\bCambodia\b/i, 'Cambodia'],
		[/\bLaos\b/i, 'Laos'],
		[/\bEcuador\b/i, 'Ecuador'],
		[/\bUruguay\b/i, 'Uruguay'],
		[/\bParaguay\b/i, 'Paraguay'],
		[/\bBolivia\b/i, 'Bolivia'],
		[/\bVenezuela\b/i, 'Venezuela'],
		[/\bPanama\b/i, 'Panama'],
		[/\bGuatemala\b/i, 'Guatemala'],
		[/\bCosta Rica\b/i, 'Costa Rica'],
		[/\bCuba\b/i, 'Cuba'],
		[/\bDominican Republic\b/i, 'Dominican Republic'],
		[/\bJamaica\b/i, 'Jamaica'],
		[/\bTrinidad\b/i, 'Trinidad and Tobago']
	];

	for (const [pattern, canonical] of aliases) {
		if (pattern.test(normalized)) return canonical;
	}

	return '';
}

async function lookupOpenFoodFactsProduct(barcode: string) {
	await applyJitterDelay();

	const response = await fetch(`${OPEN_FOOD_FACTS_API_URL}/${encodeURIComponent(barcode)}.json`, {
		headers: {
			Accept: 'application/json',
			'User-Agent': GOOGLE_MOBILE_USER_AGENT
		}
	});

	if (!response.ok) {
		return { product: null, statusCode: response.status };
	}

	const payload = (await response.json()) as {
		status?: number;
		product?: OpenFoodFactsProduct;
	};

	if (payload.status !== 1 || !payload.product) {
		return { product: null, statusCode: response.status };
	}

	return { product: payload.product, statusCode: response.status };
}

async function semanticGoogleScrape(barcode: string) {
	const googleDelayMs = JITTER_GOOGLE_MIN_MS + Math.floor(Math.random() * (JITTER_GOOGLE_MAX_MS - JITTER_GOOGLE_MIN_MS + 1));
	await new Promise((resolve) => setTimeout(resolve, googleDelayMs));

	const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`barcode ${barcode}`)}&hl=en&gl=us&num=10&pws=0`;
	const response = await fetch(searchUrl, {
		headers: buildFetchHeaders()
	});

	const html = await response.text();
	console.log(`[verify] google_status=${response.status}`);
	console.log(`[verify] google_head=${html.slice(0, 200).replace(/\s+/g, ' ')}`);

	const $ = cheerio.load(html);

	// Extract multiple content types for better coverage
	const h3Records = $('h3')
		.slice(0, 10)
		.map((_, element) => normalizeText($(element).text()))
		.get()
		.filter(Boolean);

	const divTexts = $('div[data-content-feature]')
		.slice(0, 5)
		.map((_, element) => normalizeText($(element).text()))
		.get()
		.filter(Boolean);

	const spans = $('span')
		.slice(0, 10)
		.map((_, element) => {
			const text = normalizeText($(element).text());
			return text.length > 20 && text.length < 300 ? text : '';
		})
		.get()
		.filter(Boolean);

	const titleTags = $('title')
		.map((_, element) => normalizeText($(element).text()))
		.get()
		.filter(Boolean);

	// Combine all extracted content
	const allContent = [...titleTags, ...h3Records, ...divTexts, ...spans];
	const contextText = allContent.join('\n');

	// Check if scraper is actually blocked (only Google Search title means blocked)
	const isBlocked = response.status === 403 || response.status === 429 ||
		(contextText.trim().length < 20 && contextText.includes('Google Search'));

	return {
		blocked: isBlocked,
		hasContext: Boolean(contextText && contextText.trim().length > 15),
		statusCode: response.status,
		contextText: normalizeText(contextText)
	};
}

function fallbackCorporateResult(barcode: string): OpenRouterCorporateOutput {
	const prefix = getGs1RegistrationPrefix(barcode);
	const unresolvedProduct = `Unresolved Product ${barcode}`;
	return {
		barcode,
		product: {
			verified_name: unresolvedProduct,
			name: unresolvedProduct,
			brand: 'Unresolved Brand',
			ultimate_parent: 'Unresolved Parent',
			parent: 'Unresolved Parent',
			hq: 'Unresolved HQ Country'
		},
		audit: {
			parent_evidence: 'No snippet evidence available.',
			hq_evidence: 'No snippet evidence available.'
		},
		telemetry: {
			search_present: false,
			snippets_count: 0,
			arbitration_path: 'fallback_no_market_evidence',
			search_data_received: false,
			key_indicators: [],
			decision_logic: 'No reliable market pulse text was available, so unresolved fallback identity was returned.'
		},
		verification: {
			sources_synced: ['Internal'],
			conflicts_resolved: 'Insufficient corroborated evidence; returned unresolved fallback.',
			confidence_score: 0.5
		},
		product_identity: {
			verified_name: unresolvedProduct,
			brand: 'Unresolved Brand',
			verified_brand: 'Unresolved Brand',
			category: 'Unresolved Category',
			confidence_score: 0.5
		},
		origin_data: {
			physical_origin: 'Unresolved Origin',
			legal_prefix_country: prefix
		},
		origin_details: {
			physical_origin_country: 'Unresolved Origin',
			legal_registration_prefix: prefix,
			source_of_origin: 'No explicit country-of-origin evidence found in available sources.'
		},
		corporate_structure: {
			ultimate_parent_company: 'Unresolved Parent',
			global_hq_country: 'Unresolved HQ Country'
		},
		corporate_hierarchy: {
			immediate_owner: 'Unresolved Manufacturer',
			ultimate_parent: 'Unresolved Parent',
			parent_hq_country: 'Unresolved HQ Country',
			ownership_chain: 'Unresolved Brand -> Unresolved Manufacturer -> Unresolved Parent'
		},
		compliance: {
			is_flagged: false,
			flag_reason: null
		},
		ownership_structure: {
			manufacturer: 'Unresolved Manufacturer',
			ultimate_parent: 'Unresolved Parent',
			parent_hq_country: 'Unresolved HQ Country'
		},
		compliance_status: {
			is_flagged: false,
			flag_reason: null
		},
		arbitration_log:
			'Insufficient corroborated evidence; returned unresolved labels using conservative arbitration rules.',
		product_name: unresolvedProduct,
		verified_brand: 'Unresolved Brand',
		brand: 'Unresolved Brand',
		legal_holding_company: 'Unresolved Parent',
		holding_company_hq: 'Unresolved HQ Country',
		country_of_origin: 'Unresolved Origin',
		is_flagged: false,
		flag_reason: 'Search data is ambiguous; unresolved labels used until corroborated evidence is available.',
		confidence_score: 0.5,
		source_attribution: 'Internal_Knowledge',
		data_sources_used: ['Internal_Knowledge'],
		parent_company: 'Unresolved Parent',
		origin_country: 'Unresolved Origin',
		reasoning: 'Search data is ambiguous; unresolved labels were used until corroborated evidence is available.'
	};
}

function buildEvidenceDrivenFallback(args: {
	barcode: string;
	registryData: string;
	marketPulse: string;
	offData: string;
	searchContext: string;
	deepScrape: string;
	hqPulse?: string;
	truthBundleBlock: string;
	contextText: string;
	searchPresent: boolean;
	snippetsCount: number;
	keyIndicators: string[];
	arbitrationPath: string;
	offProduct: OpenFoodFactsProduct | null;
	sourcesUsed: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'>;
}, reason: string): OpenRouterAnalyzerResult {
	const prefix = getGs1RegistrationPrefix(args.barcode);
	const offProductName = normalizeText(args.offProduct?.product_name) || `Unresolved Product ${args.barcode}`;
	const offBrandParsed = parseOffBrandDeep(args.offProduct);
	const offBrand = offBrandParsed.brand || normalizeText(args.offProduct?.brand_owner) || normalizeText(args.offProduct?.manufacturer_name) || '';
	const offParent = extractOffParentCompany(args.offProduct);
	const offOrigin = extractOffOriginCountry(args.offProduct);
	const offCategory = extractOffCategory(args.offProduct);
	const marketAndScrape = `${args.marketPulse}\n${args.deepScrape}\n${args.searchContext}\n${args.truthBundleBlock}\n${args.hqPulse || ''}`;
	const productName =
		offProductName ||
		extractProductIdentityFromEvidence(marketAndScrape, args.searchContext, args.deepScrape, args.registryData).productName ||
		`Unresolved Product ${args.barcode}`;
	const evidenceBrand =
		normalizeText(offBrand || deriveBrandFromProductName(productName) || extractBrandLeadFromMarketContext(marketAndScrape) || '') ||
		'Unresolved Brand';
	const evidenceParent =
		normalizeCompanyName(
			offParent ||
				inferParentFromEvidence(marketAndScrape, evidenceBrand) ||
				inferParentFromEvidence(args.offData || marketAndScrape, evidenceBrand) ||
				''
		) || 'Unresolved Parent';
	const evidenceOrigin =
		normalizeCountryCandidate(offOrigin || inferOriginCountryFromEvidence(marketAndScrape) || args.hqPulse || '') || 'Unresolved Origin';
	const evidenceHq =
		normalizeCountryCandidate(inferHqCountryFromEvidence(marketAndScrape) || evidenceOrigin || '') || 'Unresolved HQ Country';
	const evidenceCategory =
		!isUnresolved(offCategory)
			? offCategory
			: domainToCategory(detectLikelyDomain(`${args.offData}\n${marketAndScrape}`));
	const confidence = evidenceBrand.startsWith('Unresolved') || evidenceParent.startsWith('Unresolved') ? 0.5 : 0.8;
	const sourceAttribution = args.sourcesUsed.includes('Search_Scrape')
		? 'Search_Scrape'
		: args.sourcesUsed.includes('OFF_API')
			? 'OFF_API'
			: 'Internal_Knowledge';
	const sourcesSynced = toVerificationSources(args.sourcesUsed);
	const auditParent = pickEvidenceSnippet(marketAndScrape, evidenceBrand === 'Unresolved Brand' ? undefined : evidenceBrand);
	const auditHq = pickEvidenceSnippet(marketAndScrape, evidenceHq === 'Unresolved HQ Country' ? undefined : evidenceHq);
	const isFlagged = false;
	const flagReason = 'Search data is ambiguous; resolved using deterministic evidence fallback.';
	const arbitrationLog = `${reason}. OFF/search fallback resolved brand/company/origin without OpenRouter.`;

	return {
		barcode: args.barcode,
		product: {
			verified_name: productName,
			name: productName,
			brand: evidenceBrand,
			ultimate_parent: evidenceParent,
			parent: evidenceParent,
			hq: evidenceHq,
			category: evidenceCategory,
			confidence
		},
		audit: {
			parent_evidence: auditParent,
			hq_evidence: auditHq
		},
		forensic_report: {
			scraper_blocked: false,
			serper_fallback_active: false,
			ground_truth_source: args.offProduct ? 'OFF' : 'Serper',
			rationale: reason
		},
		forensic_audit: {
			scraper_blocked: false,
			serper_snippets_received: args.snippetsCount,
			source_hierarchy: buildSourceHierarchy({
				serperPrimary: Boolean(args.searchPresent),
				scraperAvailable: Boolean(args.deepScrape),
				offAvailable: Boolean(args.offData),
				internalFallback: !args.searchPresent && !args.offData
			}),
			conflict_resolved: true,
			rationale: 'Deterministic evidence fallback resolved the product without OpenRouter.'
		},
		telemetry: {
			search_present: args.searchPresent,
			snippets_count: args.snippetsCount,
			arbitration_path: 'evidence_fallback',
			search_data_received: args.searchPresent,
			key_indicators: args.keyIndicators,
			decision_logic: reason
		},
		verification: {
			sources_synced: sourcesSynced,
			conflicts_resolved: 'Resolved via deterministic evidence fallback after OpenRouter failure.',
			confidence_score: confidence
		},
		product_identity: {
			verified_name: productName,
			brand: evidenceBrand,
			verified_brand: evidenceBrand,
			category: evidenceCategory,
			confidence_score: confidence
		},
		origin_data: {
			physical_origin: evidenceOrigin,
			legal_prefix_country: prefix
		},
		origin_details: {
			physical_origin_country: evidenceOrigin,
			legal_registration_prefix: prefix,
			source_of_origin: 'Derived from OFF and live evidence fallback.'
		},
		corporate_structure: {
			ultimate_parent_company: evidenceParent,
			global_hq_country: evidenceHq
		},
		corporate_hierarchy: {
			immediate_owner: evidenceBrand,
			ultimate_parent: evidenceParent,
			parent_hq_country: evidenceHq,
			ownership_chain: `${evidenceBrand} -> ${evidenceBrand} -> ${evidenceParent}`
		},
		compliance: {
			is_flagged: isFlagged,
			flag_reason: null,
			reason: null
		},
		ownership_structure: {
			manufacturer: evidenceBrand,
			ultimate_parent: evidenceParent,
			parent_hq_country: evidenceHq
		},
		compliance_status: {
			is_flagged: isFlagged,
			flag_reason: null
		},
		arbitration_log: arbitrationLog,
		product_name: productName,
		verified_brand: evidenceBrand,
		brand: evidenceBrand,
		legal_holding_company: evidenceParent,
		holding_company_hq: evidenceHq,
		country_of_origin: evidenceOrigin,
		is_flagged: isFlagged,
		flag_reason: flagReason,
		confidence_score: confidence,
		source_attribution: sourceAttribution,
		data_sources_used: args.sourcesUsed,
		parent_company: evidenceParent,
		origin_country: evidenceOrigin,
		reasoning: arbitrationLog,
		verification_card_label: 'Forensic Audit'
	};
}

async function callOpenRouterAnalyzer(args: {
	barcode: string;
	registryData: string;
	marketPulse: string;
	offData: string;
	searchContext: string;
	deepScrape: string;
	hqPulse?: string;
	truthBundleBlock: string;
	evidenceBundle: string;
	contextText: string;
	searchPresent: boolean;
	snippetsCount: number;
	keyIndicators: string[];
	arbitrationPath: string;
	offProduct: OpenFoodFactsProduct | null;
	sourcesUsed: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'>;
}): Promise<OpenRouterAnalyzerResult> {
	if (!OPENROUTER_API_KEY) {
		const fallback = buildEvidenceDrivenFallback(args, 'OpenRouter API key missing; using deterministic evidence fallback');
		return {
			...fallback,
			flag_reason: `${fallback.flag_reason} (OPENROUTER_API_KEY missing, using local fallback).`,
			reasoning: `${fallback.reasoning} (OPENROUTER_API_KEY missing, using local fallback).`,
			data_sources_used: args.sourcesUsed.includes('Internal_Knowledge')
				? args.sourcesUsed
				: [...args.sourcesUsed, 'Internal_Knowledge']
		};
	}

	const offProductName = normalizeText(args.offProduct?.product_name) || 'Unresolved Product';
	const offBrandParsed = parseOffBrandDeep(args.offProduct);
	const offBrand = offBrandParsed.brand || normalizeText(args.offProduct?.brand_owner) || 'Unresolved Brand';

	const systemPrompt = `You are a master researcher analyzing product data.

CRITICAL RULES:
1. ALWAYS prioritize OpenFoodFacts (OFF) data over empty, blocked, or noisy search results
2. Treat OFF as authoritative for origin_country, category, and brand unless search provides clean, explicit corporate proof that is stronger than OFF
3. For origin_country: use OFF countries/manufacturing_places directly. If OFF says "Italy", output "Italy". Do NOT output "Unresolved Origin" if OFF has a country signal
4. For category: map OFF evidence to one of Food, Beverage, Personal Care, or Household. If OFF says beverages, output Beverage. If OFF says food/snacks/biscuits/cereal, output Food
5. For brand and parent_company: prefer OFF brand/owner/manufacturer fields before search snippets. Do not echo article titles, retailer pages, or Google UI text
6. If Search returned "Google Search" only, <20 chars, or zero snippets, ignore it and continue using OFF data only
7. If OFF and search agree, confirm the shared value. If they conflict, prefer OFF

Output RAW JSON ONLY with keys: brand, parent_company, origin_country, parent_hq_country, category, is_flagged.`;

	const userPrompt = `BARCODE: ${args.barcode}
OFF_HINT_PRODUCT: ${offProductName}
OFF_HINT_BRAND: ${offBrand}
<registry_data>
${args.registryData || 'EMPTY_REGISTRY_DATA'}
</registry_data>
<off_data>
${args.offData || 'EMPTY_OFF_DATA'}
</off_data>
<market_pulse>
${args.searchContext || 'EMPTY_MARKET_PULSE'}
</market_pulse>
<deep_scrape>
${args.deepScrape || 'EMPTY_DEEP_SCRAPE'}
</deep_scrape>
<hq_pulse>
${args.hqPulse || 'EMPTY_HQ_PULSE'}
</hq_pulse>
<evidence_bundle>
${args.evidenceBundle || 'EMPTY_EVIDENCE_BUNDLE'}
</evidence_bundle>
${args.truthBundleBlock}`;

	console.log(
		`🚀 OpenRouter Sent: barcode=${args.barcode} model=${OPENROUTER_MODEL} marketChars=${args.searchContext.length} deepScrapeChars=${args.deepScrape.length}`
	);
	console.log(`🛰️ [DATA_DENSITY] marketPulseChars=${args.searchContext.length} deepScrapeChars=${args.deepScrape.length}`);

	const response = await fetch(OPENROUTER_API_URL, {
		method: 'POST',
		headers: buildFetchHeaders({
			Authorization: `Bearer ${OPENROUTER_API_KEY}`,
			'Content-Type': 'application/json',
			'HTTP-Referer': dynamicEnv.OPENROUTER_REFERER || 'http://localhost:5173',
			'X-Title': dynamicEnv.OPENROUTER_TITLE || 'Corporate Fact Checker'
		}),
		body: JSON.stringify({
			model: OPENROUTER_MODEL,
			temperature: 0.05,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt }
			]
		})
	});

	if (!response.ok) {
		const fallback = buildEvidenceDrivenFallback(args, `OpenRouter ${response.status} fallback`);
		return {
			...fallback,
			flag_reason: `${fallback.flag_reason} (OpenRouter ${response.status} fallback).`,
			reasoning: `${fallback.reasoning} (OpenRouter ${response.status} fallback).`,
			data_sources_used: args.sourcesUsed
		};
	}

	const payload = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = payload.choices?.[0]?.message?.content ?? '';

	try {
		const parsed = JSON.parse(extractJsonObject(content)) as Partial<OpenRouterCorporateOutput>;
		const parsedConfidence =
			typeof parsed.product_identity?.confidence === 'number'
				? parsed.product_identity.confidence
				: typeof parsed.product?.confidence === 'number'
					? parsed.product.confidence
				: typeof parsed.confidence_score === 'number'
					? parsed.confidence_score
					: undefined;
		const legacyConfidence =
			typeof parsed.product_identity?.confidence_score === 'number'
				? parsed.product_identity.confidence_score
				: parsed.confidence_score;
		const confidence =
			typeof parsedConfidence === 'number'
				? Math.max(0, Math.min(1, parsedConfidence))
				: typeof legacyConfidence === 'number'
					? Math.max(0, Math.min(1, legacyConfidence))
					: 0.82;
		const productName =
			normalizeText(parsed.product_name) || normalizeText(parsed.product?.name) || offProductName || `Unresolved Product ${args.barcode}`;
		const verifiedName =
			normalizeText(parsed.product_identity?.verified_name) || productName || `Unresolved Product ${args.barcode}`;
		const brand =
			normalizeText(parsed.product_identity?.brand || parsed.product_identity?.verified_brand || parsed.verified_brand || parsed.brand || parsed.product?.brand) ||
			offBrand ||
			'Unresolved Brand';
		const category =
			normalizeText(parsed.product_identity?.category) ||
			normalizeText(parsed.product?.category) ||
			domainToCategory(detectLikelyDomain(args.contextText));
		const manufacturer =
			normalizeText(parsed.ownership_structure?.manufacturer) ||
			normalizeText(parsed.corporate_hierarchy?.immediate_owner) ||
			brand ||
			'Unresolved Manufacturer';
		let legalHoldingCompany =
			normalizeText(parsed.ownership_structure?.ultimate_parent || parsed.legal_holding_company || parsed.corporate_hierarchy?.ultimate_parent) ||
			'Unresolved Parent';
		let holdingCompanyHq =
			normalizeText(
				parsed.corporate_structure?.global_hq_country ||
					parsed.ownership_structure?.parent_hq_country ||
					parsed.holding_company_hq ||
					parsed.corporate_hierarchy?.parent_hq_country
			) || 'Unresolved HQ Country';
		const legalPrefix =
			normalizeText(parsed.origin_data?.legal_prefix_country || parsed.origin_details?.legal_registration_prefix) ||
			getGs1RegistrationPrefix(args.barcode);
		const originCountry =
			normalizeText(parsed.origin_data?.physical_origin || parsed.origin_details?.physical_origin_country || parsed.country_of_origin) ||
			extractPhysicalOriginFromContext(args.contextText) ||
			'Unresolved Origin';
		const sourceOfOrigin =
			normalizeText(parsed.origin_details?.source_of_origin) ||
			(originCountry !== 'Unresolved Origin'
				? 'Derived from explicit made-in/produced-in context in live evidence.'
				: 'No explicit produced-in evidence found; origin remains uncertain.');
		const ambiguousNote = 'Search data is ambiguous; brand identified via internal knowledge.';
		const sourceAttributionRaw = normalizeText(parsed.source_attribution);
		const sourceAttribution =
			sourceAttributionRaw && ['Internal_Knowledge', 'GS1_Registry', 'Search_Scrape'].includes(sourceAttributionRaw)
				? sourceAttributionRaw
				: args.sourcesUsed.includes('Search_Scrape')
					? 'Search_Scrape'
					: 'Internal_Knowledge';
		let flagReasonRaw =
			normalizeText(
				parsed.compliance?.reason ??
					parsed.compliance?.flag_reason ??
					parsed.compliance_status?.flag_reason ??
					parsed.flag_reason
			) ||
			'No direct documented structural link found.';
		let flagged = Boolean(parsed.compliance?.is_flagged ?? parsed.compliance_status?.is_flagged ?? parsed.is_flagged);
		let arbitrationLog =
			normalizeText(parsed.arbitration_log) ||
			'Applied arbitration gates using available evidence and selected highest-confidence manufacturer path.';
		const ownershipChain =
			normalizeText(parsed.corporate_hierarchy?.ownership_chain) ||
			`${brand} -> ${manufacturer} -> ${legalHoldingCompany}`;

		if (looksLikeRetailer(legalHoldingCompany) && !isPrivateLabelBrand(brand)) {
			legalHoldingCompany = 'Unresolved Parent';
			flagReasonRaw = `${flagReasonRaw || 'Retailer/distributor name detected in ownership candidates.'} Retailer was treated as distributor and excluded.`;
			arbitrationLog = `${arbitrationLog} Overrode distribution-layer entity and pivoted to manufacturer ownership.`;
		}

		if (confidence < 0.7 && !arbitrationLog.toLowerCase().includes('ambigu')) {
			arbitrationLog = `${arbitrationLog} Ambiguity remains due to low confidence evidence.`;
		}

		// Evidence-driven inference: prefer explicit evidence snippets over hardcoded overrides.
		try {
			const parentEvidenceContext = `${args.marketPulse}\n${args.deepScrape}\n${args.truthBundleBlock || ''}`;
			const inferredParent = inferParentFromEvidence(parentEvidenceContext, offBrand || brand || verifiedName);
			// Only promote an inferred parent when there's explicit snippet evidence supporting the company mention
			if (
				inferredParent &&
				isUnresolved(legalHoldingCompany) &&
				companyValueHasEvidenceSupport(inferredParent, parentEvidenceContext, offBrand || brand || verifiedName)
			) {
				legalHoldingCompany = inferredParent;
				arbitrationLog = `${arbitrationLog} Inferred ultimate parent from market/deep-crawl evidence: ${inferredParent}.`;
			}

			const inferredHq = inferHqCountryFromEvidence(`${args.marketPulse}\n${args.deepScrape}\n${args.truthBundleBlock || ''}`);
			if (inferredHq && isUnresolved(holdingCompanyHq)) {
				holdingCompanyHq = inferredHq;
				arbitrationLog = `${arbitrationLog} Inferred holding company HQ country from evidence: ${inferredHq}.`;
			}
		} catch {
			// non-fatal: leave arbitration as-is
		}

		if (flagged && !hasDirectEvidenceForFlag(flagReasonRaw)) {
			flagged = false;
			flagReasonRaw = 'No direct documented structural link found.';
		}

		const flagReason =
			confidence < 0.9
				? flagReasonRaw.includes(ambiguousNote)
					? flagReasonRaw
					: `${flagReasonRaw || 'Low-confidence result.'} ${ambiguousNote}`
				: flagReasonRaw || 'Corporate ownership assessment completed.';

		const normalizedSources = Array.isArray(parsed.data_sources_used)
			? parsed.data_sources_used
					.map((s) => normalizeText(s).toUpperCase())
					.map((s) => {
						if (s === 'OFF_API') return 'OFF_API' as const;
						if (s === 'SEARCH_SCRAPE') return 'Search_Scrape' as const;
						if (s === 'INTERNAL_KNOWLEDGE') return 'Internal_Knowledge' as const;
						return null;
					})
					.filter((s): s is 'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge' => Boolean(s))
			: [];

		const dataSourcesUsed = normalizedSources.length > 0 ? normalizedSources : args.sourcesUsed;
		const parsedArbitrationPath = normalizeText(parsed.telemetry?.arbitration_path);
		const parsedKeyIndicators = Array.isArray(parsed.telemetry?.key_indicators)
			? parsed.telemetry.key_indicators.map((value) => normalizeText(value)).filter(Boolean).slice(0, 8)
			: [];
		const telemetryKeyIndicators = parsedKeyIndicators.length > 0 ? parsedKeyIndicators : args.keyIndicators;
		const telemetryDecision =
			normalizeText(parsed.telemetry?.decision_logic) ||
			normalizeText(parsed.telemetry?.arbitration_path) ||
			arbitrationLog;
		const resolvedArbitrationPath =
			parsedArbitrationPath ||
			args.arbitrationPath ||
			(telemetryDecision.toLowerCase().includes('metadata ghost')
				? 'market_override_void_registry'
				: 'standard_resolution_path');

		// Clean and enforce final TITAN schema fields
		const cleanOrUnresolved = (val?: string) => {
			const raw = normalizeText(val || '');
			const cleaned = regexCleaner(raw);
			return cleaned && !isUnresolved(cleaned) ? cleaned : 'Unresolved';
		};

		const final_product_name = cleanOrUnresolved(productName);
		const final_brand = cleanOrUnresolved(brand);
		const final_parent_company = cleanOrUnresolved(legalHoldingCompany);
		const final_hq_country = cleanOrUnresolved(holdingCompanyHq);

		// Geopolitical heuristic: check passed HQ pulse / market / deep evidence for Israeli indicators
		const geoEvidence = normalizeText(`${args.hqPulse || ''}\n${args.marketPulse || ''}\n${args.deepScrape || ''}`).toLowerCase();
		const israeliIndicators = /\bisrael\b|tel aviv|haifa|israeli|israel's|israel-/i;
		const isIsraeli = Boolean(geoEvidence.match(israeliIndicators));
		const audit_reasoning = geoEvidence ? pickEvidenceSnippet(geoEvidence, isIsraeli ? 'israel' : undefined) : 'No direct geopolitical snippets found.';

		return {
			barcode: args.barcode,
			product: {
				verified_name: verifiedName,
				name: verifiedName,
				brand,
				ultimate_parent: legalHoldingCompany,
				parent: legalHoldingCompany,
				hq: holdingCompanyHq,
				category,
				confidence
			},
			telemetry: {
				search_present: args.searchPresent,
				snippets_count: args.snippetsCount,
				arbitration_path: resolvedArbitrationPath,
				search_data_received: args.searchPresent,
				key_indicators: telemetryKeyIndicators,
				decision_logic: telemetryDecision
			},
			verification: {
				sources_synced: toVerificationSources(dataSourcesUsed),
				conflicts_resolved: arbitrationLog,
				confidence_score: confidence
			},
			product_identity: {
				verified_name: verifiedName,
				brand,
				verified_brand: brand,
				category,
				confidence,
				confidence_score: confidence
			},
			origin_data: {
				physical_origin: originCountry,
				legal_prefix_country: legalPrefix
			},
			origin_details: {
				physical_origin_country: originCountry,
				legal_registration_prefix: legalPrefix,
				source_of_origin: sourceOfOrigin
			},
			corporate_structure: {
				ultimate_parent_company: legalHoldingCompany,
				global_hq_country: holdingCompanyHq
			},
			corporate_hierarchy: {
				immediate_owner: manufacturer,
				ultimate_parent: legalHoldingCompany,
				parent_hq_country: holdingCompanyHq,
				ownership_chain: ownershipChain
			},
			compliance: {
				is_flagged: flagged,
				flag_reason: flagged ? flagReason : null,
				reason: flagged ? flagReason : 'No direct documented structural link found.'
			},
			ownership_structure: {
				manufacturer,
				ultimate_parent: legalHoldingCompany,
				parent_hq_country: holdingCompanyHq
			},
			compliance_status: {
				is_flagged: flagged,
				flag_reason: flagged ? flagReason : null
			},
			arbitration_log: arbitrationLog,
			product_name: final_product_name,
			verified_brand: final_brand,
			brand: final_brand,
			legal_holding_company: final_parent_company,
			holding_company_hq: final_hq_country,
			country_of_origin: originCountry,
			is_flagged: flagged,
			flag_reason: flagReason,
			confidence_score: confidence,
			source_attribution: sourceAttribution,
			data_sources_used: dataSourcesUsed,
			parent_company: final_parent_company,
			parent_hq_country: final_hq_country,
			hq_country: final_hq_country,
			israeli_linked: Boolean(isIsraeli),
			category,
			audit_reasoning: audit_reasoning,
			origin_country: originCountry,
			reasoning: flagReason
		};
	} catch (e) {
		console.error(`🚨 [SCHEMA_FAIL] Failed to parse OpenRouter content for ${args.barcode}. RawStart=${String(content).slice(0,200)}`, e);
		const fallback = buildEvidenceDrivenFallback(args, 'OpenRouter JSON parse fallback');
		return {
			...fallback,
			flag_reason: `${fallback.flag_reason} (JSON parse fallback).`,
			reasoning: `${fallback.reasoning} (JSON parse fallback).`,
			data_sources_used: args.sourcesUsed
		};
	}
}

async function loadCachedProduct(barcode: string): Promise<OpenRouterCorporateOutput | null> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const adminSupabase = getAdminSupabase() as any;
	const baseSelect = 'barcode,brand,parent_company,origin_country,is_flagged';
	const extendedSelect = `${baseSelect},category,parent_hq_country,source_attribution,arbitration_log`;

	let { data, error } = await adminSupabase
		.from('products')
		.select(extendedSelect)
		.eq('barcode', barcode)
		.maybeSingle();

	if (error) {
		console.warn('[verify] extended cache select failed, falling back to base columns', error);
		const fallback = await adminSupabase
			.from('products')
			.select(baseSelect)
			.eq('barcode', barcode)
			.maybeSingle();
		data = fallback.data;
		error = fallback.error;
	}

	if (error) {
		console.error('[verify] cache select failed', error);
		return null;
	}

	if (!data) return null;

	const cached = data as CachedProductRow;
	const cachedSourceRaw = normalizeText(cached.source_attribution);
	const cachedSource =
		cachedSourceRaw && ['Internal_Knowledge', 'GS1_Registry', 'Search_Scrape'].includes(cachedSourceRaw)
			? cachedSourceRaw
			: 'Internal_Knowledge';
	const cachedCategory = normalizeText(cached.category) || 'Unresolved Category';
	const cachedParentHq = normalizeText(cached.parent_hq_country) || 'Unresolved HQ Country';
	const cachedArbitrationLog =
		normalizeText(cached.arbitration_log) ||
		'Loaded from cache; prior arbitration details unavailable in cached schema.';

	return {
		barcode: cached.barcode,
		product: {
			verified_name: `Barcode ${cached.barcode}`,
			name: `Barcode ${cached.barcode}`,
			brand: normalizeText(cached.brand) || 'Unresolved Brand',
			ultimate_parent: normalizeText(cached.parent_company) || 'Unresolved Parent',
			parent: normalizeText(cached.parent_company) || 'Unresolved Parent',
			hq: cachedParentHq,
			category: cachedCategory,
			confidence: 0.95
		},
		telemetry: {
			search_present: false,
			snippets_count: 0,
			arbitration_path: 'cache_hit',
			search_data_received: false,
			key_indicators: [],
			decision_logic: 'Result loaded from cache before running market pulse or ownership crawl.'
		},
		verification: {
			sources_synced: ['Internal'],
			conflicts_resolved: cachedArbitrationLog,
			confidence_score: 0.95
		},
		product_identity: {
			verified_name: `Barcode ${cached.barcode}`,
			brand: normalizeText(cached.brand) || 'Unresolved Brand',
			verified_brand: normalizeText(cached.brand) || 'Unresolved Brand',
			category: cachedCategory,
			confidence_score: 0.95
		},
		origin_data: {
			physical_origin: normalizeText(cached.origin_country) || 'Unresolved Origin',
			legal_prefix_country: getGs1RegistrationPrefix(cached.barcode)
		},
		origin_details: {
			physical_origin_country: normalizeText(cached.origin_country) || 'Unresolved Origin',
			legal_registration_prefix: getGs1RegistrationPrefix(cached.barcode),
			source_of_origin: 'Loaded from cache; origin source detail may be unavailable.'
		},
		corporate_structure: {
			ultimate_parent_company: normalizeText(cached.parent_company) || 'Unresolved Parent',
			global_hq_country: cachedParentHq
		},
		corporate_hierarchy: {
			immediate_owner: normalizeText(cached.brand) || 'Unresolved Manufacturer',
			ultimate_parent: normalizeText(cached.parent_company) || 'Unresolved Parent',
			parent_hq_country: cachedParentHq,
			ownership_chain: `${normalizeText(cached.brand) || 'Unresolved Brand'} -> ${normalizeText(cached.brand) || 'Unresolved Manufacturer'} -> ${normalizeText(cached.parent_company) || 'Unresolved Parent'}`
		},
		compliance: {
			is_flagged: Boolean(cached.is_flagged),
			flag_reason: cached.is_flagged ? 'Cached flagged result from Supabase.' : null
		},
		ownership_structure: {
			manufacturer: normalizeText(cached.brand) || 'Unresolved Manufacturer',
			ultimate_parent: normalizeText(cached.parent_company) || 'Unresolved Parent',
			parent_hq_country: cachedParentHq
		},
		compliance_status: {
			is_flagged: Boolean(cached.is_flagged),
			flag_reason: cached.is_flagged ? 'Cached flagged result from Supabase.' : null
		},
		arbitration_log: cachedArbitrationLog,
		product_name: `Barcode ${cached.barcode}`,
		verified_brand: normalizeText(cached.brand) || 'Unresolved Brand',
		brand: normalizeText(cached.brand) || 'Unresolved Brand',
		legal_holding_company: normalizeText(cached.parent_company) || 'Unresolved Parent',
		holding_company_hq: cachedParentHq,
		country_of_origin: normalizeText(cached.origin_country) || 'Unresolved Origin',
		is_flagged: Boolean(cached.is_flagged),
		flag_reason: 'Cached result from Supabase.',
		confidence_score: 0.95,
		source_attribution: cachedSource,
		data_sources_used: ['Internal_Knowledge'],
		parent_company: normalizeText(cached.parent_company) || 'Unresolved Parent',
		origin_country: normalizeText(cached.origin_country) || 'Unresolved Origin',
		reasoning: cachedArbitrationLog
	};
}

async function checkAndDecrementQuota(userId: string): Promise<ScanQuota> {
	try {
		const adminSupabase = getAdminSupabase() as unknown as {
			from: (table: string) => {
				select: (columns: string) => {
					eq: (column: string, value: string) => {
						maybeSingle: () => Promise<{
							data: { plan?: string; scan_limit?: number; scans_used?: number; period_end?: string } | null;
							error: unknown;
						}>;
					};
				};
				update: (values: Record<string, unknown>) => {
					eq: (column: string, value: string) => Promise<{ error: unknown }>;
				};
			};
		};

		const { data, error } = await adminSupabase
			.from('subscriptions')
			.select('plan,scan_limit,scans_used,period_end')
			.eq('user_id', userId)
			.maybeSingle();

		if (error || !data) {
			return { allowed: true, plan: 'free', scansRemaining: 15 };
		}

		const plan = data.plan === 'supporter' ? 'supporter' : 'free';
		const scanLimit = typeof data.scan_limit === 'number' ? data.scan_limit : plan === 'supporter' ? 999_999 : 15;
		const scansUsed = typeof data.scans_used === 'number' ? data.scans_used : 0;
		const periodEnd = data.period_end ? new Date(data.period_end) : new Date(0);
		const now = new Date();

		if (now > periodEnd) {
			await adminSupabase
				.from('subscriptions')
				.update({
					scans_used: 0,
					period_start: now.toISOString(),
					period_end: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
				})
				.eq('user_id', userId);
			return { allowed: true, plan, scansRemaining: scanLimit };
		}

		const scansRemaining = Math.max(0, scanLimit - scansUsed);
		if (scansRemaining <= 0) {
			return {
				allowed: false,
				plan,
				scansRemaining: 0,
				reason: plan === 'free' ? 'You have used all free scans for this period.' : 'Monthly scan limit reached.'
			};
		}

		await adminSupabase.from('subscriptions').update({ scans_used: scansUsed + 1 }).eq('user_id', userId);
		return { allowed: true, plan, scansRemaining: scansRemaining - 1 };
	} catch {
		return { allowed: true, plan: 'free', scansRemaining: 99 };
	}
}

async function saveScanHistory(userId: string, barcode: string, result: OpenRouterCorporateOutput): Promise<void> {
	try {
		const adminSupabase = getAdminSupabase() as unknown as {
			from: (table: string) => {
				upsert: (values: Record<string, unknown>, options?: { onConflict?: string }) => Promise<{ error: unknown }>;
			};
		};

		await adminSupabase.from('scan_history').upsert(
			{
				user_id: userId,
				barcode,
				product_name: normalizeText(result.product?.name || result.product_name) || 'Unknown',
				brand: normalizeText(result.brand || result.product?.brand) || 'Unknown',
				parent_company: normalizeText(result.parent_company || result.legal_holding_company) || 'Unknown',
				origin_country: normalizeText(result.origin_country || result.country_of_origin) || 'Unknown',
				parent_hq_country: normalizeText(result.parent_hq_country || result.holding_company_hq) || 'Unknown',
				category: normalizeText(result.category || result.product?.category || result.product_identity?.category) || 'Unknown',
				is_flagged: Boolean(result.is_flagged),
				confidence_score: result.confidence_score || result.product?.confidence || 0,
				scanned_at: new Date().toISOString()
			},
			{ onConflict: 'user_id,barcode' }
		);
	} catch {
		// Non-fatal history writes should not break scans.
	}
}

async function cacheScanResult(result: {
    barcode: string;
    brand: string;
    parent_company: string;
    origin_country: string;
    category: string;
    parent_hq_country: string;
    is_flagged: boolean;
}) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const adminSupabase = getAdminSupabase() as any;
	// Build a minimal payload that matches the exact DB columns and avoids the removed 'name' column.
	const payload = {
		barcode: result.barcode,
		brand: normalizeText(result.brand) || 'UNKNOWN',
		parent_company: normalizeText(result.parent_company) || 'UNKNOWN',
		origin_country: normalizeText(result.origin_country) || 'UNKNOWN',
		parent_hq_country: normalizeText(result.parent_hq_country) || 'UNKNOWN',
		category: normalizeText(result.category) || 'UNKNOWN',
		is_flagged: Boolean(result.is_flagged)
	};

	console.log('🛰️ [DB_PAYLOAD]', JSON.stringify(payload));

	const { error } = await adminSupabase.from('products').upsert(payload, { onConflict: 'barcode' });

	if (error) {
		console.error('[verify] cache upsert failed', error);
		throw new Error('Failed to persist verification result to products cache.');
	}
}

async function robustScan(barcode: string, cameraInput: ScanEvidenceInput = {}): Promise<OpenRouterCorporateOutput> {
	const cameraInputProvided = Boolean(normalizeText(cameraInput.ocr_text || cameraInput.image_data_url || cameraInput.image_base64 || cameraInput.image_url || ''));
	const cameraEvidence = cameraInputProvided
		? await resolveCameraEvidence(cameraInput).catch(() => ({ ocrText: '', source: null, prompt: '' }))
		: { ocrText: '', source: null, prompt: '' };
	const cached = cameraInputProvided ? null : await loadCachedProduct(barcode);
	if (cached) {
		const cachedRow = cached as OpenRouterCorporateOutput & { category?: string; country_of_origin?: string };
		const cachedParent = normalizeText(cached.product?.ultimate_parent || cached.parent_company || '');
		const cachedHq = normalizeText(cached.product?.hq || cached.corporate_structure?.global_hq_country || '');
		const cachedBrand = normalizeText(cached.product?.brand || cached.brand || '');
		const cachedOrigin = normalizeText(cachedRow.origin_country || cachedRow.country_of_origin || '');
		const cachedCategory = normalizeText(cachedRow.category || cached.product?.category || '');
		const cachedSource = normalizeText((cached as { source_attribution?: string }).source_attribution);
		const cachedArbitrationLog = normalizeText((cached as { arbitration_log?: string }).arbitration_log);
		const cachedOriginCanonical = inferCountryFromText(cachedOrigin);
		const cachedParentLooksNoisy =
			/cnn|following is a list|google search|shopping|results?|^org-|^the following/i.test(cachedParent) ||
			cachedParent.length > 60;
		const cachedBrandLooksLikeProduct = looksLikeProductLabel(cachedBrand) || /\b(drink|dates|biscuits|chocolate|soda|juice|water|snack)\b/i.test(cachedBrand);
		const cachedLooksStale = cachedSource === 'Internal_Knowledge' && /loaded from cache/i.test(cachedArbitrationLog);
		const cachedNeedsRefresh = false; // Only bypass on explicit unresolved signals above
		if (
			isUnresolved(cachedParent) ||
			isUnresolved(cachedHq) ||
			isUnresolved(cachedOrigin) ||
			!cachedOriginCanonical ||
			isUnresolved(cachedCategory) ||
			cachedNeedsRefresh ||
			cachedParentLooksNoisy ||
			cachedBrandLooksLikeProduct ||
			cachedLooksStale
		) {
			console.log(`⚠️ [CACHE] Bypassing stale unresolved cache for ${barcode} so live evidence can re-run.`);
		} else {
		cached.forensic_report = {
			scraper_blocked: false,
			serper_fallback_active: false,
			ground_truth_source: 'OFF',
			rationale: 'Loaded from cache; previous triage result reused.'
		};
		cached.forensic_audit = {
			scraper_blocked: false,
			serper_snippets_received: 0,
			source_hierarchy: 'Cache Primary > Internal Fallback',
			conflict_resolved: true,
			rationale: 'Loaded from cache; strict forensic audit reused from persisted result.'
		};
		return cached;
		}
	}

	const barcodeValidation = validateBarcode(barcode);
	const gs1RegistrationCountry = barcodeValidation.gs1Country || lookupGs1Country(barcode);
	console.log(`🔢 [BARCODE] type=${barcodeValidation.type} valid=${barcodeValidation.valid} gs1=${gs1RegistrationCountry}`);
	if (cameraEvidence.prompt) console.log(`📷 [CAMERA] ${cameraEvidence.prompt}`);
	const cameraIdentity = cameraEvidence.ocrText
		? extractProductIdentityFromEvidence(cameraEvidence.ocrText, cameraEvidence.ocrText, cameraEvidence.ocrText, cameraEvidence.ocrText)
		: {};
	const cameraProductName = normalizeText(cameraIdentity.productName || '');
	const cameraBrandMatch = cameraEvidence.ocrText.match(/\b([A-Z][A-Za-z0-9&'-]{2,40}(?:\s+[A-Z][A-Za-z0-9&'-]{2,40}){0,3})\b/);
	const cameraParentMatch = cameraEvidence.ocrText.match(
		/(?:imported by|distributed by|manufactured by|made by|packed by|packed for|manufactured for|licensed by|distributed for)\s+([A-Z][A-Za-z0-9&.,'\-\s]{2,80})/i
	);
	const cameraBrandFromOcr = normalizeText(
		cameraIdentity.brand ||
		cameraBrandMatch?.[1] ||
		extractBrandLeadFromMarketContext(cameraEvidence.ocrText) ||
		deriveBrandFromProductName(cameraProductName) ||
		''
	);
	const cameraParentCompany = normalizeCompanyName(
		cameraParentMatch?.[1] ||
		(cameraEvidence.ocrText ? inferParentFromEvidence(cameraEvidence.ocrText, cameraBrandFromOcr || cameraProductName) : '')
	).replace(/\s+(?:head office|headquarters|hq)\b.*$/i, '');
	const cameraOriginCountry = normalizeCountryCandidate(
		cameraEvidence.ocrText
			? inferOriginCountryFromEvidence(cameraEvidence.ocrText, cameraBrandFromOcr || cameraParentCompany || cameraProductName)
			: ''
	);
	const cameraHqCountry = normalizeCountryCandidate(
		cameraEvidence.ocrText
			? inferHqCountryFromEvidence(cameraEvidence.ocrText, cameraParentCompany || cameraBrandFromOcr || cameraProductName)
			: ''
	);
	const cameraOnlyMode = cameraInputProvided && !normalizeText(barcode);

	if (cameraOnlyMode) {
		console.log('📷 [CAMERA_ONLY] Running camera-first scan without a valid barcode.');
		const cameraSubject = cameraBrandFromOcr || cameraProductName || normalizeText(cameraEvidence.ocrText.split(/\r?\n/)[0] || '') || 'Camera Product';
		const cameraSearch = await serperPrimarySearchWithRetry(cameraSubject).catch(() => ({
			result: { query: cameraSubject, contextText: '', statusCode: 0, used: false, snippetCount: 0 },
			retried: false,
			primaryQuery: cameraSubject,
			retryQuery: null,
			firstAttemptSnippets: 0
		}));
		const cameraScrape = await semanticGoogleScrape(cameraSubject).catch(() => ({ blocked: true, hasContext: false, statusCode: 0, contextText: '' }));
		const cameraPublicVerification = await withTimeout(
			runPublicVerificationPass(cameraSubject).catch(() => null),
			6000,
			null
		);
		const cameraOffContext = [
			`CAMERA_OCR_TEXT: ${cameraEvidence.ocrText || 'Unresolved OCR Text'}`,
			cameraProductName ? `CAMERA_PRODUCT_NAME: ${cameraProductName}` : '',
			cameraBrandFromOcr ? `CAMERA_BRAND: ${cameraBrandFromOcr}` : '',
			cameraParentCompany ? `CAMERA_PARENT_COMPANY: ${cameraParentCompany}` : '',
			cameraOriginCountry ? `CAMERA_ORIGIN_COUNTRY: ${cameraOriginCountry}` : '',
			cameraHqCountry ? `CAMERA_HQ_COUNTRY: ${cameraHqCountry}` : ''
		].filter(Boolean).join('\n');
		const cameraEvidenceBundle = buildEvidenceBundle({
			barcode: cameraSubject,
			offProduct: null,
			offBrand: cameraBrandFromOcr,
			offOriginCountry: cameraOriginCountry,
			offCategory: 'Unresolved Category',
			offParentCompany: cameraParentCompany,
			publicVerification: cameraPublicVerification,
			searchContext: cameraSearch.result.contextText,
			deepScrape: cameraScrape.contextText,
			hqPulse: '',
			truthBundleBlock: cameraOffContext
		});
		const cameraResult = await callOpenRouterAnalyzer({
			barcode: cameraSubject,
			registryData: cameraOffContext,
			marketPulse: cameraSearch.result.contextText,
			offData: cameraOffContext,
			searchContext: cameraSearch.result.contextText,
			deepScrape: cameraScrape.contextText,
			hqPulse: '',
			truthBundleBlock: cameraOffContext,
			evidenceBundle: `<evidence_bundle>\n<product_name>${cameraEvidenceBundle.product_name}</product_name>\n<brand>${cameraEvidenceBundle.brand}</brand>\n<parent_company>${cameraEvidenceBundle.parent_company}</parent_company>\n<parent_hq_country>${cameraEvidenceBundle.parent_hq_country}</parent_hq_country>\n<origin_country>${cameraEvidenceBundle.origin_country}</origin_country>\n<category>${cameraEvidenceBundle.category}</category>\n<sources>${cameraEvidenceBundle.sources.join(' | ')}</sources>\n</evidence_bundle>`,
			contextText: cameraSearch.result.contextText,
			searchPresent: Boolean(cameraSearch.result.contextText),
			snippetsCount: cameraSearch.result.snippetCount ?? 0,
			keyIndicators: extractKeyIndicators(cameraEvidence.ocrText),
			arbitrationPath: 'camera_first',
			offProduct: null,
			sourcesUsed: [cameraSearch.result.contextText ? 'Search_Scrape' : 'Internal_Knowledge']
		});
		cameraResult.product.brand = cameraResult.product.brand || cameraBrandFromOcr || 'Unresolved Brand';
		cameraResult.brand = cameraResult.brand || cameraResult.product.brand;
		cameraResult.verified_brand = cameraResult.verified_brand || cameraResult.product.brand;
		cameraResult.parent_company = cameraResult.parent_company || cameraParentCompany || 'Unresolved Parent';
		cameraResult.legal_holding_company = cameraResult.legal_holding_company || cameraResult.parent_company;
		cameraResult.parent_hq_country = cameraResult.parent_hq_country || cameraHqCountry || 'Unresolved HQ Country';
		cameraResult.holding_company_hq = cameraResult.holding_company_hq || cameraResult.parent_hq_country;
		cameraResult.origin_country = cameraResult.origin_country || cameraOriginCountry || 'Unresolved Origin';
		cameraResult.country_of_origin = cameraResult.country_of_origin || cameraResult.origin_country;
		cameraResult.product_name = cameraResult.product_name || cameraProductName || `Camera Product ${barcode || ''}`.trim();
		cameraResult.product.verified_name = cameraResult.product.verified_name || cameraResult.product_name;
		cameraResult.product.name = cameraResult.product.name || cameraResult.product_name;
		cameraResult.product_identity.verified_name = cameraResult.product_identity.verified_name || cameraResult.product_name;
		cameraResult.product_identity.brand = cameraResult.product_identity.brand || cameraResult.product.brand;
		cameraResult.product_identity.verified_brand = cameraResult.product_identity.verified_brand || cameraResult.product.brand;
		cameraResult.corporate_structure.ultimate_parent_company = cameraResult.corporate_structure.ultimate_parent_company || cameraResult.parent_company;
		cameraResult.corporate_structure.global_hq_country = cameraResult.corporate_structure.global_hq_country || cameraResult.parent_hq_country;
		const cameraCorporateHierarchy = cameraResult.corporate_hierarchy || {
			immediate_owner: cameraResult.product.brand,
			ultimate_parent: cameraResult.parent_company,
			parent_hq_country: cameraResult.parent_hq_country,
			ownership_chain: `${cameraResult.product.brand} -> ${cameraResult.parent_company}`
		};
		cameraCorporateHierarchy.immediate_owner = cameraCorporateHierarchy.immediate_owner || cameraResult.product.brand;
		cameraCorporateHierarchy.ultimate_parent = cameraCorporateHierarchy.ultimate_parent || cameraResult.parent_company;
		cameraCorporateHierarchy.parent_hq_country = cameraCorporateHierarchy.parent_hq_country || cameraResult.parent_hq_country;
		cameraResult.corporate_hierarchy = cameraCorporateHierarchy;
		cameraResult.ownership_structure.manufacturer = cameraResult.ownership_structure.manufacturer || cameraResult.product.brand;
		cameraResult.ownership_structure.ultimate_parent = cameraResult.ownership_structure.ultimate_parent || cameraResult.parent_company;
		cameraResult.ownership_structure.parent_hq_country = cameraResult.ownership_structure.parent_hq_country || cameraResult.parent_hq_country;
		if (cameraEvidence.prompt || isUnresolved(cameraResult.parent_company) || isUnresolved(cameraResult.parent_hq_country) || isUnresolved(cameraResult.brand)) {
			cameraResult.scan_guidance = {
				next_step: 'camera_ocr',
				message: cameraEvidence.prompt || 'Move closer to the label and capture the front panel so OCR can read the brand and manufacturer.'
			};
		}
		return cameraResult;
	}

	const emptyOffLookup = { product: null, statusCode: 0 };
	const emptyMarketPulseSearch: SerperPrimaryResult = {
		result: { query: '', contextText: '', statusCode: 0, used: false, snippetCount: 0 },
		retried: false,
		primaryQuery: '',
		retryQuery: null,
		firstAttemptSnippets: 0
	};
	const emptyScrape = { blocked: true, hasContext: false, statusCode: 0, contextText: '' };

	const [offLookup, marketPulseSearch, scrape] = await Promise.all([
		withTimeout(lookupOpenFoodFactsProduct(barcode).catch(() => emptyOffLookup), 8000, emptyOffLookup),
		withTimeout(serperPrimarySearchWithRetry(barcode).catch(() => emptyMarketPulseSearch), 10000, emptyMarketPulseSearch),
		withTimeout(semanticGoogleScrape(barcode).catch(() => emptyScrape), 8000, emptyScrape)
	]);

	let marketPulse = marketPulseSearch.result;

	let offProduct = offLookup.product;
	const offBrandParsed = parseOffBrandDeep(offProduct);
	const offBrand = offBrandParsed.brand || normalizeText(offProduct?.brand_owner) || cameraBrandFromOcr || '';
	const offOriginCountry = cameraOriginCountry || extractOffOriginCountry(offProduct);
	const offCategory = extractOffCategory(offProduct);
	const offParentCompany = cameraParentCompany || extractOffParentCompany(offProduct);
	const upcItemDBResult = !offProduct?.product_name ? await lookupUPCItemDB(barcode) : null;
	const brandForWiki = offBrand || upcItemDBResult?.brand || cameraBrandFromOcr || '';
	const wikiResult = brandForWiki && !offParentCompany ? await lookupWikipediaBrand(brandForWiki) : null;
	const publicVerification = await withTimeout(
		runPublicVerificationPass(
			offParentCompany || wikiResult?.parentCompany || cameraParentCompany || cameraBrandFromOcr || offBrand || normalizeText(offProduct?.product_name) || barcode,
			normalizeText((offProduct as { website?: string } | null)?.website || '')
		).catch(() => null),
		6000,
		null
	);
	if (publicVerification) {
		console.log(`🛰️ [PUBLIC_VERIFY] source=${publicVerification.source} company=${publicVerification.company} hq=${publicVerification.hqCountry}`);
	}
	let offContext = offProduct ? buildOpenFoodFactsContext(offProduct) : '';
	if (upcItemDBResult && !offProduct) {
		const upcLines = [
			`UPC_ITEMDB product_name: ${upcItemDBResult.title || 'Unresolved Product'}`,
			`UPC_ITEMDB brand: ${upcItemDBResult.brand || 'Unresolved Brand'}`,
			`UPC_ITEMDB category: ${upcItemDBResult.category || 'Unresolved Category'}`,
			`UPC_ITEMDB description: ${upcItemDBResult.description || ''}`
		].filter(Boolean).join('\n');
		offContext = offContext ? `${offContext}\n${upcLines}` : upcLines;
	}
	if (wikiResult?.summary) {
		const wikiLines = [
			`WIKIPEDIA brand_summary: ${wikiResult.summary}`,
			wikiResult.parentCompany ? `WIKIPEDIA parent_company: ${wikiResult.parentCompany}` : '',
			wikiResult.country ? `WIKIPEDIA country: ${wikiResult.country}` : ''
		].filter(Boolean).join('\n');
		offContext = offContext ? `${offContext}\n${wikiLines}` : wikiLines;
	}
	if (cameraEvidence.ocrText) {
		const cameraLines = [
			`CAMERA_OCR_TEXT: ${cameraEvidence.ocrText}`,
			cameraProductName ? `CAMERA_PRODUCT_NAME: ${cameraProductName}` : '',
			cameraBrandFromOcr ? `CAMERA_BRAND: ${cameraBrandFromOcr}` : '',
			cameraParentCompany ? `CAMERA_PARENT_COMPANY: ${cameraParentCompany}` : '',
			cameraOriginCountry ? `CAMERA_ORIGIN_COUNTRY: ${cameraOriginCountry}` : '',
			cameraHqCountry ? `CAMERA_HQ_COUNTRY: ${cameraHqCountry}` : ''
		].filter(Boolean).join('\n');
		offContext = offContext ? `${offContext}\n${cameraLines}` : cameraLines;
	}
	if (gs1RegistrationCountry && gs1RegistrationCountry !== 'Unresolved GS1 Country') {
		offContext = `${offContext}\nGS1_REGISTRATION_COUNTRY: ${gs1RegistrationCountry} (barcode prefix registration — indicates legal/commercial origin, not necessarily manufacturing location)`;
	}
	const evidenceBundle = buildEvidenceBundle({
		barcode,
		offProduct,
		offBrand,
		offOriginCountry,
		offCategory,
		offParentCompany,
		publicVerification,
		searchContext: '',
		deepScrape: scrape.contextText || '',
		hqPulse: '',
		truthBundleBlock: offContext
	});
	console.log(`📥 [OFF] Status: ${offLookup.statusCode}`);

	// If OFF is missing/404 or Serper returned no snippets, run hard compensation searches
	if ((!offLookup.product || offLookup.statusCode === 404) && (marketPulse.snippetCount ?? 0) === 0) {
		console.log('⚠️ [EMPTY_REGISTRY] OFF missing or 404; triggering full compensation Serper hard-search.');
		const hard = await performSerperHardSearch(barcode, offLookup.product).catch(() => ({ queries: [], results: [], mergedContext: '' }));
		if (hard && hard.mergedContext) {
			// assign merged context and sum snippet counts
			marketPulse = Object.assign({}, marketPulse, {
				contextText: hard.mergedContext,
				snippetCount: hard.results.reduce((s: number, r: { snippetCount?: number }) => s + (r.snippetCount || 0), 0)
			});
		}
	}
	const serperFallbackActive = scrape.statusCode === 429;
	if (serperFallbackActive) {
		console.log(
			'🚨 [Block Alert] 429 detected on deep scrape; silently promoting Serper as primary truth source.'
		);
	}
	if ((marketPulse.snippetCount ?? 0) > 0) {
		console.log(`📡 [SERPER] Snippets used: primary=${marketPulse.snippetCount ?? 0}`);
	} else {
		console.log('⚠️ Empty Search (No Credits): primary market pulse returned 0 snippets');
	}

	const offDomain = detectLikelyDomain(offContext);
	const marketEvidenceContext = serperFallbackActive
		? marketPulse.contextText || scrape.contextText
		: marketPulse.contextText || scrape.contextText;
	const marketDomain = detectLikelyDomain(marketEvidenceContext);
	let registryOverrideNote = '';
	if (
		offProduct &&
		offDomain !== 'unknown' &&
		marketDomain !== 'unknown' &&
		offDomain !== marketDomain &&
		(marketPulse.snippetCount ?? 0) >= 3
	) {
		registryOverrideNote = `Rejected stale registry entry as metadata ghost (registry domain: ${offDomain}, market domain: ${marketDomain}). Ground truth locked to live market pulse.`;
		offProduct = null;
		offContext = '';
	}

	const corporateCrawlQuery = `${barcode} product manufacturer parent company`;
	const corporateCrawl = await serperSearch(corporateCrawlQuery).catch(() => ({
		query: corporateCrawlQuery,
		contextText: '',
		statusCode: 0,
		used: false,
		snippetCount: 0
	}));
	if ((corporateCrawl.snippetCount ?? 0) > 0) {
		console.log(
			`📡 [SERPER] Snippets used: primary=${marketPulse.snippetCount ?? 0} ownership=${corporateCrawl.snippetCount ?? 0}`
		);
	} else {
		console.log('⚠️ Empty Search (No Credits): ownership crawl returned 0 snippets');
	}
	if (marketPulseSearch.retried) {
		console.log(
			`🔁 [SERPER] Retry completed. first_attempt=${marketPulseSearch.firstAttemptSnippets} final=${marketPulse.snippetCount ?? 0}`
		);
	}

	const publicVerificationContext = publicVerification
		? [
			`PUBLIC_VERIFY source: ${publicVerification.source}`,
			`PUBLIC_VERIFY company: ${publicVerification.company}`,
			`PUBLIC_VERIFY hq_country: ${publicVerification.hqCountry}`,
			`PUBLIC_VERIFY website: ${publicVerification.website || 'Unresolved Website'}`,
			`PUBLIC_VERIFY evidence: ${publicVerification.evidence}`
		].join('\n')
		: '';
	const registryData = [registryOverrideNote, offContext || 'NO_REGISTRY_DATA', publicVerificationContext].filter(Boolean).join('\n');
	const marketPulseData = marketEvidenceContext || 'NO_MARKET_PULSE_DATA';
	const offData = buildOpenFoodFactsContext(offProduct || { product_name: 'Unresolved Product', categories: 'Unresolved Category', countries: 'Unresolved Origin', ingredients_text: '' });
	const evidenceBundleBlock = `<evidence_bundle>\n<product_name>${evidenceBundle.product_name}</product_name>\n<brand>${evidenceBundle.brand}</brand>\n<parent_company>${evidenceBundle.parent_company}</parent_company>\n<parent_hq_country>${evidenceBundle.parent_hq_country}</parent_hq_country>\n<origin_country>${evidenceBundle.origin_country}</origin_country>\n<category>${evidenceBundle.category}</category>\n<sources>${evidenceBundle.sources.join(' | ')}</sources>\n</evidence_bundle>`;
	let searchContext = marketPulseData;
	// Exhaustive Google UI noise stripping before AI reads context
	searchContext = searchContext.replace(/Google Search|Images|Videos|Shopping|Sign in|Settings|Skip to main content|All filters|Tools|SafeSearch/gi, '');
	// Keep the broader cleanup variant too for consistency with earlier scan telemetry.
	searchContext = searchContext.replace(/About these results|More results|Feedback|Privacy|Terms/gi, '');
	// Log cleaned context size and preview for auditing (mandated V81)
	console.log('🛰️ [DATA_LOAD]', searchContext.length);
	console.log('📝 [CLEAN_CONTEXT]', searchContext.substring(0, 200));
	// Per TITAN_FORGE_V45_FINAL: pass the full consolidated evidence stream
	const marketPulseForModel = normalizeText(searchContext).slice(0, 4000);

	console.log(`🔍 [DEBUG] corporateCrawl.contextText.length=${corporateCrawl.contextText?.length || 0}`);
	console.log(`🔍 [DEBUG] scrape.contextText.length=${scrape.contextText?.length || 0}`);

	let deepScrape = 'NO_DEEP_SCRAPE_DATA';
	if (corporateCrawl.contextText && corporateCrawl.contextText.length > 50) {
		deepScrape = corporateCrawl.contextText;
	} else if (scrape.contextText && scrape.contextText.length > 50) {
		deepScrape = scrape.contextText;
	} else if (corporateCrawl.contextText) {
		// fallback to corporateCrawl even if short, prefer corporateCrawl over noisy scrape
		deepScrape = corporateCrawl.contextText;
	}

	console.log(`🔍 [DEBUG] deepScrape final length=${deepScrape.length} first100chars=${deepScrape.slice(0, 100)}`);

	const corporateSignalFromSearch = containsManufacturerSignals(`${searchContext}\n${deepScrape}`);
	const serperPromotedPrimary = serperFallbackActive || !offContext;
	if (serperPromotedPrimary && (marketPulse.snippetCount ?? 0) > 0) {
		console.log('📡 [SERPER] Promoted as Primary Truth to resolve unresolved OFF fields.');
	}
	console.log(`🛰️ [DATA_DENSITY] marketPulseChars=${marketPulseForModel.length} deepScrapeChars=${deepScrape.length}`);
	console.log('🧬 [FUSION_INPUT]:', { hasOFF: !!offData, searchLength: searchContext.length });
	const truthBundleBlock = `<truth_bundle>\n<off_evidence>\n${offContext || 'Source [OFF] failed; rely on remaining evidence.'}\n</off_evidence>\n<serper_evidence>\n${marketPulse.contextText || 'Source [Serper] failed; rely on remaining evidence.'}\n</serper_evidence>\n<scraper_evidence>\n${scrape.contextText || 'Source [Scraper] failed; rely on remaining evidence.'}\n</scraper_evidence>\n<ownership_crawl_evidence>\n${corporateCrawl.contextText || 'Source [Corporate_Crawl] failed; rely on remaining evidence.'}\n</ownership_crawl_evidence>\n</truth_bundle>`;

	if (!offContext && !marketPulse.contextText && !scrape.contextText) {
		const fallback = fallbackCorporateResult(barcode);
		console.log('⚖️ Arbitration: missing registry and market evidence; returning manual-input required fallback.');
		return {
			...fallback,
			forensic_report: {
				scraper_blocked: serperFallbackActive,
				serper_fallback_active: serperFallbackActive,
				ground_truth_source: marketPulse.contextText ? 'Serper' : 'OFF',
				rationale:
					'Missing usable registry/scraper evidence, request remains unresolved and depends on available Serper pulse.'
			},
			forensic_audit: {
				scraper_blocked: serperFallbackActive,
				serper_snippets_received: (marketPulse.snippetCount ?? 0) + (corporateCrawl.snippetCount ?? 0),
				source_hierarchy: buildSourceHierarchy({
					serperPrimary: true,
					scraperAvailable: false,
					offAvailable: false,
					internalFallback: true
				}),
				conflict_resolved: false,
				rationale:
					'All primary evidence streams are empty or blocked; unresolved result returned with strict failure notes.'
			},
			telemetry: {
				search_present: false,
				snippets_count: 0,
				arbitration_path: 'missing_registry_and_market_data',
				search_data_received: false,
				key_indicators: [],
				decision_logic:
					'Neither registry data nor market pulse data was available, so manual brand input is required.'
			},
			error:
				'Missing registry and market evidence. Please provide manual brand input to continue forensic ownership mapping.',
			arbitration_log:
				'No data in registry_block and market_pulse_block; returning error JSON and requesting manual brand input per protocol.'
		};
	}

	const mergedContext = [registryData, marketPulseData, deepScrape].filter(Boolean).join('\n\n');
	const keyIndicators = extractKeyIndicators([marketPulseData, deepScrape].join('\n'));
	const snippetsCount = (marketPulse.snippetCount ?? 0) + (corporateCrawl.snippetCount ?? 0);
	const arbitrationPath = serperFallbackActive
		? 'serper_promoted_after_429'
		: registryOverrideNote
			? 'market_override_void_registry'
			: 'registry_market_consistent';
	console.log(`⚖️ [ARBITRATION] ${registryOverrideNote || 'Registry and market pulse did not trigger metadata-ghost void.'}`);
	const sourcesUsed: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'> = [];
	if (offProduct) sourcesUsed.push('OFF_API');
	if (scrape.hasContext || marketPulse.used || corporateCrawl.used) sourcesUsed.push('Search_Scrape');
	if (sourcesUsed.length === 0 || offLookup.statusCode === 404 || offLookup.statusCode === 406) {
		sourcesUsed.push('Internal_Knowledge');
	}

	// Attempt to extract a brand lead from market/crawl/registry for HQ pulse probing
	const brandLead = extractBrandLeadFromMarketContext(marketPulse.contextText || corporateCrawl.contextText || offContext || '');
	const hqSubject = brandLead || offParentCompany || offBrand || normalizeText(offProduct?.product_name) || barcode;
	const hqQuery = `${hqSubject} global headquarters country`;
	const hqPulse = await serperSearch(hqQuery).catch(() => ({
		query: hqQuery,
		contextText: '',
		statusCode: 0,
		used: false,
		snippetCount: 0
	}));

	console.log('🛰️ [DATA_LOAD]', marketPulseData.length);
	console.log('📝 [CLEAN_PREVIEW]', marketPulseData.substring(0, 150));
	const ai = await callOpenRouterAnalyzer({
		barcode,
		registryData,
		marketPulse: marketPulseForModel,
		offData,
		searchContext,
		deepScrape,
		hqPulse: hqPulse.contextText || '',
		truthBundleBlock,
		evidenceBundle: evidenceBundleBlock,
		contextText: mergedContext,
		searchPresent: Boolean(marketPulse.contextText || scrape.contextText),
		snippetsCount,
		keyIndicators,
		arbitrationPath,
		offProduct,
		sourcesUsed
	});

	const searchLooksNoisy = searchContext.length < 20 || /google search|shopping|images|videos|sign in|settings|results?/i.test(searchContext);
	if (offProduct) {
		if (!isUnresolved(offOriginCountry)) {
			ai.origin_country = offOriginCountry;
			ai.country_of_origin = offOriginCountry;
			if (!ai.origin_data) {
				ai.origin_data = { physical_origin: offOriginCountry, legal_prefix_country: getGs1RegistrationPrefix(barcode) };
			} else {
				ai.origin_data.physical_origin = offOriginCountry;
			}
			if (!ai.origin_details) {
				ai.origin_details = {
					physical_origin_country: offOriginCountry,
					legal_registration_prefix: getGs1RegistrationPrefix(barcode),
					source_of_origin: 'Derived from OFF country/manufacturing signals.'
				};
			} else {
				ai.origin_details.physical_origin_country = offOriginCountry;
				ai.origin_details.source_of_origin = 'Derived from OFF country/manufacturing signals.';
			}
		}

		if (!isUnresolved(offCategory)) {
			ai.category = offCategory;
			if (ai.product) ai.product.category = offCategory;
			if (!ai.product_identity) {
				ai.product_identity = {
					verified_name: ai.product?.name || `Barcode ${barcode}`,
					brand: ai.brand || 'Unresolved Brand',
					category: offCategory,
					confidence_score: ai.confidence_score || 0.82
				};
			} else {
				ai.product_identity.category = offCategory;
			}
		}

		if (
			offParentCompany &&
			(searchLooksNoisy || isUnresolved(ai.parent_company) || isUnresolved(ai.legal_holding_company) || /cnn|following is a list|google search|shopping|results?/i.test(normalizeText(ai.parent_company || ai.legal_holding_company)))
		) {
			ai.parent_company = offParentCompany;
			ai.legal_holding_company = offParentCompany;
			if (ai.product) {
				ai.product.ultimate_parent = offParentCompany;
				ai.product.parent = offParentCompany;
			}
			if (ai.corporate_structure) ai.corporate_structure.ultimate_parent_company = offParentCompany;
			if (ai.corporate_hierarchy) ai.corporate_hierarchy.ultimate_parent = offParentCompany;
			if (ai.ownership_structure) ai.ownership_structure.ultimate_parent = offParentCompany;
		}

		if (offParentCompany && !isUnresolved(offParentCompany)) {
			ai.parent_company = offParentCompany;
			ai.legal_holding_company = offParentCompany;
			if (ai.product) {
				ai.product.ultimate_parent = offParentCompany;
				ai.product.parent = offParentCompany;
			}
			if (ai.corporate_structure) ai.corporate_structure.ultimate_parent_company = offParentCompany;
			if (ai.corporate_hierarchy) ai.corporate_hierarchy.ultimate_parent = offParentCompany;
			if (ai.ownership_structure) ai.ownership_structure.ultimate_parent = offParentCompany;
		}

		ai.arbitration_log = `${normalizeText(ai.arbitration_log)} OFF reconciliation applied${searchLooksNoisy ? ' because search evidence was noisy or empty' : ''}.`.trim();
	}
	// Run verifier (LLM self-check + deterministic rules) to validate AI-extracted fields
	try {
		const llmSelf = await runLLMSelfCheck({
			barcode,
			evidenceBundleBlock: evidenceBundleBlock || '',
			aiSnapshot: ai,
			marketPulse: marketPulseData || '',
			deepScrape: deepScrape || '',
			registryData: registryData || '',
			hqPulse: hqPulse?.contextText || ''
		}).catch(() => null);

		const verified: VerifiedResult = {
			brand: scoreAndDecideField('brand', normalizeText(ai.brand || ai.product?.brand || ''), normalizeText(offParentCompany || ''), publicVerification || null, marketPulseData || '', deepScrape || '', llmSelf ?? undefined) as VerifiedField,
			parent_company: scoreAndDecideField('parent_company', normalizeText(ai.parent_company || ai.legal_holding_company || ai.product?.ultimate_parent || ''), normalizeText(offParentCompany || ''), publicVerification || null, marketPulseData || '', deepScrape || '', llmSelf ?? undefined) as VerifiedField,
			parent_hq_country: scoreAndDecideField(
				'parent_hq_country',
				normalizeText(ai.parent_hq_country || ai.holding_company_hq || ''),
				null,
				publicVerification || null,
				marketPulseData || '',
				deepScrape || '',
				llmSelf ?? undefined,
				normalizeText(ai.parent_company || ai.legal_holding_company || ai.product?.ultimate_parent || offParentCompany || ai.product?.parent || '')
			) as VerifiedField,
			origin_country: scoreAndDecideField('origin_country', normalizeText(ai.origin_country || ai.country_of_origin || ''), normalizeText(offOriginCountry || ''), publicVerification || null, marketPulseData || '', deepScrape || '', llmSelf ?? undefined) as VerifiedField,
			category: scoreAndDecideField('category', normalizeText(ai.category || ai.product_identity?.category || ''), normalizeText(offCategory || ''), publicVerification || null, marketPulseData || '', deepScrape || '', llmSelf ?? undefined) as VerifiedField,
			is_flagged: { value: !!ai.is_flagged || false, accepted: Boolean(ai.is_flagged), confidence: ai.is_flagged ? 0.9 : 0.1, supporting_sources: [] },
			overall_confidence: 0.0,
			notes: []
		};

		// compute simple overall confidence
		verified.overall_confidence = Number(((verified.brand.confidence + verified.parent_company.confidence + verified.parent_hq_country.confidence + verified.origin_country.confidence + verified.category.confidence) / 5).toFixed(2));

		// collect per-field provenance (do not assume ai.forensic_audit shape)
		const perFieldProvenance = [
			{ field: 'brand', result: verified.brand },
			{ field: 'parent_company', result: verified.parent_company },
			{ field: 'parent_hq_country', result: verified.parent_hq_country },
			{ field: 'origin_country', result: verified.origin_country },
			{ field: 'category', result: verified.category },
			{ field: 'is_flagged', result: verified.is_flagged }
		];

		// Attach provenance as a non-invasive private property to ai (avoids typing issues)
		(ai as unknown as Record<string, unknown>)['_forensic_provenance'] = perFieldProvenance;

		// Apply accepted fields back to ai
		applyVerificationToAi(ai, verified);

		const perFieldSummary = perFieldProvenance.map((p) => ({ field: p.field, accepted: p.result.accepted, confidence: p.result.confidence }));
		console.log(`🔐 [VERIFIER] overall_confidence=${verified.overall_confidence} per_field=${JSON.stringify(perFieldSummary)}`);
	} catch (err) {
		console.warn('🔐 [VERIFIER] verifier failed', err);
	}

	// GEOPOLITICAL AUDIT: probe for Israeli operations / funding ties for the inferred parent
	try {
		const ultimateParent = normalizeText(ai.product?.ultimate_parent || ai.legal_holding_company || ai.parent_company || ai.product?.parent || '');
		if (ultimateParent && ultimateParent.toLowerCase() !== 'unresolved parent') {
			const auditQuery = `${ultimateParent} Israeli operations funding 2026`;
			const auditResult = await serperSearch(auditQuery).catch(() => ({ query: auditQuery, contextText: '', statusCode: 0, used: false, snippetCount: 0 }));
			const auditContext = (auditResult.contextText || '').trim();
			const israeliKeywords = ['israel', 'tel aviv', 'haifa', 'israeli', 'invest', 'r&d', 'research', 'manufactur', 'plant', 'subsidiary'];
			const evidenceHit = israeliKeywords.find((k) => auditContext.toLowerCase().includes(k));
			const geopoliticalStatus = evidenceHit ? 'Israeli-Linked' : 'International-Neutral';
			const isIsraeli = Boolean(evidenceHit);

			ai.geopolitical_audit = {
				status: geopoliticalStatus,
				evidence: auditContext || 'No direct snippets found for Israeli operations/funding 2026.',
				israeli_related: isIsraeli
			};

			if (isIsraeli) console.log(`⚖️ [AUDIT] Geopolitical audit flagged Israeli-related evidence for ${ultimateParent}`);
			else console.log(`⚖️ [AUDIT] No Israeli-related evidence found for ${ultimateParent}`);
		}
	} catch {
		// non-fatal
	}

	// Add a verification card label so UI can show the new audit
	ai.verification_card_label = 'Forensic Audit';
	// Evidence-driven inference post-analysis: only populate parent/hq if unresolved and we have snippets
	try {
		let inferredParent = inferParentFromEvidence(`${marketPulseData}\n${deepScrape}\n${registryData}\n${hqPulse.contextText || ''}`, ai.brand || ai.product?.brand || offBrand || '');
		if (!inferredParent) {
			const productNameFallback = normalizeText(ai.product?.name || ai.product_identity?.verified_name || offProduct?.product_name || `Barcode ${barcode}`);
			const brandFallback = normalizeText(
				ai.product?.brand || ai.product_identity?.brand || ai.brand || offBrand || deriveBrandFromProductName(productNameFallback) || ''
			);
			if (brandFallback && !isUnresolved(brandFallback) && isStrongCompanyCandidate(brandFallback)) {
				inferredParent = brandFallback;
			}
		}
		const inferredHq = inferHqCountryFromEvidence(`${hqPulse.contextText || marketPulseData}\n${deepScrape}`);
		const productNameFallback = normalizeText(ai.product?.name || ai.product_identity?.verified_name || offProduct?.product_name || `Barcode ${barcode}`);
		const derivedBrandFallback = deriveBrandFromProductName(productNameFallback);
		const brandFallback = normalizeText(ai.product?.brand || ai.product_identity?.brand || ai.brand || offBrand || derivedBrandFallback || '');

		if (!ai.audit) ai.audit = { parent_evidence: 'No snippet evidence available.', hq_evidence: 'No snippet evidence available.' };

		// Try evidence-driven extraction if the model left a barcode-style placeholder or unresolved name
		try {
			if (isBarcodePlaceholder(ai.product?.name) || isUnresolved(ai.product?.name)) {
				const extracted = extractProductIdentityFromEvidence(mergedContext, marketPulseData, deepScrape, registryData);
				if (extracted.productName && !isBarcodePlaceholder(extracted.productName)) {
					ai.product.name = extracted.productName;
					ai.product.verified_name = extracted.productName;
					ai.product_identity.verified_name = extracted.productName;
					ai.arbitration_log = `${ai.arbitration_log} Promoted product name from market/deep evidence: ${extracted.productName}.`;
					ai.audit.parent_evidence = pickEvidenceSnippet([marketPulseData, deepScrape, registryData].join('\n'), extracted.productName);
				}
				if (extracted.brand && isUnresolved(ai.product?.brand)) {
					ai.product.brand = extracted.brand;
					ai.product_identity.brand = extracted.brand;
					ai.product_identity.verified_brand = extracted.brand;
					ai.brand = extracted.brand;
					ai.verified_brand = extracted.brand;
					ai.arbitration_log = `${ai.arbitration_log} Promoted brand from market evidence: ${extracted.brand}.`;
				}
			}
		} catch {
			// non-fatal: fall back to simple heuristics below
		}

		if (productNameFallback && isUnresolved(ai.product?.name)) {
			ai.product.name = productNameFallback;
			ai.product.verified_name = productNameFallback;
			ai.product_identity.verified_name = productNameFallback;
		}
		if (brandFallback && isUnresolved(ai.product?.brand)) {
			ai.product.brand = brandFallback;
			ai.product_identity.brand = brandFallback;
			ai.product_identity.verified_brand = brandFallback;
			ai.brand = brandFallback;
			ai.verified_brand = brandFallback;
		}
		if (derivedBrandFallback && looksLikeProductLabel(ai.product?.brand || '') && !isUnresolved(derivedBrandFallback)) {
			ai.product.brand = derivedBrandFallback;
			ai.product_identity.brand = derivedBrandFallback;
			ai.product_identity.verified_brand = derivedBrandFallback;
			ai.brand = derivedBrandFallback;
			ai.verified_brand = derivedBrandFallback;
			ai.arbitration_log = `${ai.arbitration_log} Promoted brand from recovered product name: ${derivedBrandFallback}.`;
		}

		if (
			inferredParent &&
			isUnresolved(ai.product?.ultimate_parent) &&
			isStrongCompanyCandidate(inferredParent) &&
			companyValueHasEvidenceSupport(inferredParent, `${marketPulseData}\n${deepScrape}\n${registryData}`, ai.brand || ai.product?.brand || offBrand || '')
		) {
			const p = inferredParent;
			ai.product.ultimate_parent = p;
			ai.product.parent = p;
			ai.legal_holding_company = p;
			ai.parent_company = p;
			if (ai.corporate_structure) ai.corporate_structure.ultimate_parent_company = p;
			if (ai.ownership_structure) ai.ownership_structure.ultimate_parent = p;
			ai.arbitration_log = `${ai.arbitration_log} Inferred parent from market/HQ evidence: ${p}.`;
			ai.audit.parent_evidence = pickEvidenceSnippet(`${marketPulseData}\n${deepScrape}\n${registryData}`, p);
		} else {
			ai.audit.parent_evidence = pickEvidenceSnippet(`${marketPulseData}\n${deepScrape}\n${registryData}`, ai.product?.ultimate_parent || '');
		}

		if (inferredHq && isUnresolved(ai.corporate_structure?.global_hq_country)) {
			const h = inferredHq;
				if (!ai.corporate_structure) ai.corporate_structure = { ultimate_parent_company: ai.product?.ultimate_parent || '', global_hq_country: h };
				else ai.corporate_structure.global_hq_country = h;
				ai.holding_company_hq = h;
				if (ai.ownership_structure) ai.ownership_structure.parent_hq_country = h;
			ai.arbitration_log = `${ai.arbitration_log} Inferred HQ country from market/HQ evidence: ${h}.`;
			ai.audit.hq_evidence = pickEvidenceSnippet(hqPulse.contextText || `${marketPulseData}\n${deepScrape}`, h);
		} else {
			ai.audit.hq_evidence = pickEvidenceSnippet(hqPulse.contextText || `${marketPulseData}\n${deepScrape}`, ai.corporate_structure?.global_hq_country || '');
		}
	} catch {
		// Non-fatal: continue with AI output
	}

	let supplementalCorporateContext = '';
	try {
		const unresolvedCorporateFields =
			isUnresolved(ai.parent_company) ||
			isUnresolved(ai.legal_holding_company) ||
			isUnresolved(ai.parent_hq_country) ||
			isUnresolved(ai.holding_company_hq) ||
			isUnresolved(ai.origin_country) ||
			isUnresolved(ai.country_of_origin);
		if (unresolvedCorporateFields) {
			const supplementalSubject = normalizeText(
				offParentCompany ||
					ai.parent_company ||
					ai.legal_holding_company ||
					offBrand ||
					ai.brand ||
					ai.product?.brand ||
					ai.product?.name ||
					offProduct?.product_name ||
					ai.product_identity?.verified_name ||
					barcode
			);
			const supplemental = await runSupplementalCorporateSearch(supplementalSubject, barcode);
			supplementalCorporateContext = supplemental.contextText || '';
			if (supplementalCorporateContext) {
				ai.arbitration_log = `${ai.arbitration_log} Supplemental Serper evidence gathered for unresolved corporate fields.`;
			}
		}
	} catch {
		// Supplemental search is best-effort only.
	}

	const finalEvidenceContext = [marketPulseData, deepScrape, registryData, hqPulse.contextText || '', supplementalCorporateContext, cameraEvidence.ocrText]
		.filter(Boolean)
		.join('\n');
	const productAnchor = normalizeText(ai.product?.name || ai.product_identity?.verified_name || offProduct?.product_name || ai.brand || ai.product?.brand || offBrand || '');
	const parentAnchor = normalizeText(ai.brand || ai.product?.brand || offBrand || productAnchor);

	const finalOriginCountry =
		!isUnresolved(offOriginCountry)
			? offOriginCountry
			: normalizeCountryCandidate(
					inferOriginCountryFromEvidence(finalEvidenceContext, productAnchor || parentAnchor) ||
					''
			  ) ||
				(gs1RegistrationCountry && gs1RegistrationCountry !== 'Unresolved GS1 Country' ? gs1RegistrationCountry : 'GS1 Country Unmapped');
	const finalParentCompanyRaw =
			!isUnresolved(offParentCompany)
				? offParentCompany
				: normalizeText(
					publicVerification?.company ||
					// Only accept an inferred parent when explicit evidence mentions the company
					(() => {
						const inferredCandidate = inferParentFromEvidence(finalEvidenceContext, parentAnchor);
						if (inferredCandidate && companyValueHasEvidenceSupport(inferredCandidate, finalEvidenceContext, parentAnchor)) return inferredCandidate;
						// fall back to AI-promoted parent only if AI's value is supported in snippets
						if (
							companyValueHasEvidenceSupport(
								ai.parent_company || ai.legal_holding_company || ai.product?.ultimate_parent || ai.product?.parent || '',
								finalEvidenceContext,
								parentAnchor
							)
						) {
							return normalizeCompanyName(ai.parent_company || ai.legal_holding_company || ai.product?.ultimate_parent || ai.product?.parent || '');
						}
						return '';
					})() || ''
				);

	// Normalize final parent company into a clean, human-readable label
	const finalParentCompany = normalizeCompanyName(finalParentCompanyRaw) || 'Unresolved Parent';
	const verifiedHqCountry =
		publicVerification &&
		(publicVerification.source === 'OfficialSite' || publicVerification.source === 'Registry') &&
		!isUnresolved(publicVerification.hqCountry) &&
		companyHasHqEvidence(finalParentCompany, `${finalEvidenceContext}\n${publicVerification.evidence}`, parentAnchor)
			? publicVerification.hqCountry
			: '';
	// Only accept inferred HQ country when there is explicit snippet evidence linking the parent company to an HQ/country mention.
	const inferredHqCandidate = inferHqCountryFromEvidence(`${finalEvidenceContext}\n${finalParentCompany}`, finalParentCompany || parentAnchor);
	const inferredHqAccepted =
		Boolean(finalParentCompany) &&
		Boolean(inferredHqCandidate) &&
		companyHasHqEvidence(finalParentCompany, `${finalEvidenceContext}\n${finalParentCompany}`, parentAnchor);
	const finalParentHqCountry = normalizeText(verifiedHqCountry || (inferredHqAccepted ? inferredHqCandidate : '')) || 'Unresolved HQ Country';
	const finalCategory =
		!isUnresolved(offCategory)
			? offCategory
			: normalizeText(ai.category || ai.product_identity?.category || domainToCategory(detectLikelyDomain(`${offContext}\n${marketPulseData}\n${deepScrape}`))) ||
				'Unresolved Category';

	if (publicVerification?.company && isStrongCompanyCandidate(publicVerification.company)) {
		ai.parent_company = normalizeCompanyName(publicVerification.company) || ai.parent_company;
		ai.legal_holding_company = normalizeCompanyName(publicVerification.company) || ai.legal_holding_company;
	}
	if (publicVerification?.hqCountry && !isUnresolved(publicVerification.hqCountry)) {
		ai.parent_hq_country = publicVerification.hqCountry;
		ai.holding_company_hq = publicVerification.hqCountry;
	}

	ai.origin_country = finalOriginCountry;
	ai.country_of_origin = finalOriginCountry;
	ai.parent_company = finalParentCompany;
	ai.legal_holding_company = finalParentCompany;
	ai.parent_hq_country = finalParentHqCountry;
	ai.holding_company_hq = finalParentHqCountry;
	ai.category = finalCategory;
	if (ai.product) {
		ai.product.parent = finalParentCompany;
		ai.product.ultimate_parent = finalParentCompany;
		ai.product.hq = finalParentHqCountry;
		ai.product.category = finalCategory;
	}
	if (ai.product_identity) ai.product_identity.category = finalCategory;
	if (ai.origin_data) ai.origin_data.physical_origin = finalOriginCountry;
	if (ai.origin_details) ai.origin_details.physical_origin_country = finalOriginCountry;
	if (ai.corporate_structure) ai.corporate_structure.ultimate_parent_company = finalParentCompany;
	if (ai.corporate_structure) ai.corporate_structure.global_hq_country = finalParentHqCountry;
	if (ai.corporate_hierarchy) ai.corporate_hierarchy.ultimate_parent = finalParentCompany;
	if (ai.corporate_hierarchy) ai.corporate_hierarchy.parent_hq_country = finalParentHqCountry;
	if (ai.ownership_structure) ai.ownership_structure.ultimate_parent = finalParentCompany;
	if (ai.ownership_structure) ai.ownership_structure.parent_hq_country = finalParentHqCountry;
	if (ai.product_identity) ai.product_identity.verified_brand = normalizeText(ai.brand || ai.product_identity.brand || offBrand || 'Unresolved Brand');

	ai.verification = {
		sources_synced: toVerificationSources(ai.data_sources_used),
		conflicts_resolved:
			registryOverrideNote ||
			normalizeText(ai.arbitration_log) ||
			'No explicit conflict detected; triad evidence aligned.',
		confidence_score:
			typeof ai.confidence_score === 'number'
				? ai.confidence_score
				: typeof ai.product?.confidence === 'number'
					? ai.product.confidence
					: 0.82
	};

	ai.forensic_report = {
		scraper_blocked: serperFallbackActive,
		serper_fallback_active: serperFallbackActive,
		ground_truth_source: serperFallbackActive
			? 'Serper'
			: scrape.hasContext
				? 'Scraper'
				: marketPulse.used
					? 'Serper'
					: 'OFF',
		rationale:
			registryOverrideNote ||
			(serperPromotedPrimary
				? 'Serper promoted as primary truth for arbitration.'
				: 'Triangulated OFF, Serper, and scraper evidence with resilient fallback behavior.')
	};

	ai.forensic_audit = {
		scraper_blocked: serperFallbackActive || scrape.blocked,
		serper_snippets_received: snippetsCount,
		source_hierarchy: buildSourceHierarchy({
			serperPrimary: serperPromotedPrimary || Boolean(marketPulse.contextText),
			scraperAvailable: Boolean(scrape.contextText),
			offAvailable: Boolean(offContext),
			internalFallback: ai.data_sources_used.includes('Internal_Knowledge')
		}),
		conflict_resolved: Boolean(registryOverrideNote || corporateSignalFromSearch || serperPromotedPrimary),
		rationale:
			registryOverrideNote ||
			(marketPulseSearch.retried
				? 'Barcode-only Serper query returned 0 snippets; strict retry with product-name query applied.'
				: 'Strict arbitration used available Serper/Scraper/OFF streams without retry escalation.')
	};

	console.log(`⚖️ [ARBITRATION] product=${ai.product.name} brand=${ai.product.brand} parent=${ai.product.ultimate_parent}`);

	const dbPayload = {
		barcode: ai.barcode,
		brand: normalizeText(ai.brand || ai.product?.brand || ai.product_identity?.brand || ai.verified_brand) || 'UNKNOWN',
		parent_company: normalizeText(ai.parent_company || ai.legal_holding_company) || 'UNKNOWN',
		origin_country: normalizeText(ai.origin_country || ai.country_of_origin) || 'UNKNOWN',
		category: normalizeText(ai.category || ai.product_identity?.category) || 'UNKNOWN',
		parent_hq_country: normalizeText(ai.parent_hq_country || ai.holding_company_hq || ai.corporate_structure?.global_hq_country) || 'UNKNOWN',
		is_flagged: Boolean(ai.is_flagged)
	};

	console.log('🛰️ [DB_PAYLOAD]', JSON.stringify(dbPayload));

	await cacheScanResult(dbPayload);

	return ai;
}

export const POST: RequestHandler = async ({ request }) => {
	const headers = corsHeaders(request.headers.get('origin'));
	const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';

	if (!checkRateLimit(ip)) {
		return json({ error: 'Too many requests. Please try again later.' }, { status: 429, headers });
	}

	try {
		const body = (await request.json().catch(() => ({}))) as VerifyBody;
		const barcode = body.barcode?.trim();
		const cameraInput: ScanEvidenceInput = {
			ocr_text: body.ocr_text,
			image_data_url: body.image_data_url,
			image_base64: body.image_base64,
			image_url: body.image_url
		};
		const cameraEvidence = await resolveCameraEvidence(cameraInput).catch(() => ({ ocrText: '', source: null, prompt: '' }));
		const hasCameraEvidence = Boolean(cameraEvidence.ocrText || cameraInput.ocr_text || cameraInput.image_data_url || cameraInput.image_base64 || cameraInput.image_url);

		if (!barcode && !hasCameraEvidence) {
			return json({ error: 'Provide a barcode or a camera image to scan.' }, { status: 400, headers });
		}

		const barcodeValidation = barcode ? validateBarcode(barcode) : { valid: false, type: 'unknown' as const, digits: '', error: 'No barcode provided' };
		if (barcode && !barcodeValidation.valid && !hasCameraEvidence) {
			return json(
				{
					error: barcodeValidation.error || `Invalid barcode: ${barcodeValidation.type}`,
					barcode_validation: barcodeValidation
				},
				{ status: 400, headers }
			);
		}

		let userId: string | null = null;
		const authHeader = request.headers.get('authorization') || '';
		if (authHeader.startsWith('Bearer ')) {
			const token = authHeader.slice(7).trim();
			if (token) {
				try {
					const adminSupabase = getAdminSupabase() as unknown as {
						auth: {
							getUser: (jwt: string) => Promise<{ data: { user: { id: string } | null }; error: unknown }>;
						};
					};
					const { data } = await adminSupabase.auth.getUser(token);
					userId = data.user?.id || null;
				} catch {
					userId = null;
				}
			}
		}

		if (userId) {
			const quota = await checkAndDecrementQuota(userId);
			if (!quota.allowed) {
				return json(
					{ error: quota.reason || 'Scan quota exceeded.', quota: { plan: quota.plan, scansRemaining: quota.scansRemaining } },
					{ status: 402, headers }
				);
			}
		}

		const result = await withTimeout(
			robustScan(barcode || '', cameraInput),
			20_000,
			{
				...fallbackCorporateResult(barcode || cameraEvidence.ocrText || 'camera'),
				error: 'Scan timed out. Please try again.',
				arbitration_log: 'Hard timeout reached in POST handler.'
			} as OpenRouterCorporateOutput
		);

		const needsCameraFallback =
			Boolean(cameraEvidence.prompt) ||
			isUnresolved(result.parent_company) ||
			isUnresolved(result.parent_hq_country) ||
			isUnresolved(result.brand) ||
			(result.confidence_score || result.product?.confidence || 0) < 0.72;

		if (needsCameraFallback) {
			const resultPayload = result as Record<string, unknown>;
			resultPayload.scan_guidance = {
				next_step: 'camera_ocr',
				message:
					cameraEvidence.prompt ||
					'Point the camera at the product label so OCR and AI can extract the remaining fields.'
			};
		}

		if (userId) {
			saveScanHistory(userId, barcode || result.barcode, result).catch(() => null);
		}

		return json(result, { headers });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal server error';
		console.error('[verify] POST failed', error);
		return json({ error: message }, { status: 500, headers });
	}
};
