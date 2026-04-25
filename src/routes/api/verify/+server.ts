import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import * as cheerio from 'cheerio';
import type { RequestHandler } from './$types';
import { getAdminSupabase } from '$lib/server/supabase';

type VerifyBody = {
	barcode?: string;
	action?: 'scan';
};

type OpenFoodFactsProduct = {
	product_name?: string;
	brands?: string;
	brand_owner?: string;
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

type OpenRouterCorporateOutput = {
	barcode: string;
	product?: {
		name: string;
		brand: string;
		category: string;
		confidence: number;
	};
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
const OPENROUTER_MODEL = env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';
const BROWSER_ACCEPT_HEADER =
	'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const GOOGLE_MOBILE_USER_AGENT =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
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
		{ error: 'GET method not allowed. Use POST /api/verify with JSON body: { "barcode": "..." }.' },
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
	return String(value).replace(/\s+/g, ' ').trim();
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

function buildScrapeHeaders() {
	return {
		'User-Agent': GOOGLE_MOBILE_USER_AGENT,
		Accept: BROWSER_ACCEPT_HEADER,
		'Accept-Language': 'en-US,en;q=0.5',
		'Sec-Fetch-Mode': 'navigate',
		'Sec-Fetch-Site': 'none',
		Referer: 'https://www.google.com/'
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
		.slice(0, 8)
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
	if (!env.SEARCH_API_KEY) {
		return { query, contextText: '', statusCode: 0, used: false };
	}

	const response = await fetch(SERPER_API_URL, {
		method: 'POST',
		headers: {
			'X-API-KEY': env.SEARCH_API_KEY,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ q: query, gl: 'us', hl: 'en', num: 10 })
	});

	if (!response.ok) {
		return { query, contextText: '', statusCode: response.status, used: false };
	}

	const payload = (await response.json()) as SerperPayload;
	const contextText = summarizeSerperPayload(payload);
	return {
		query,
		contextText,
		statusCode: response.status,
		used: Boolean(contextText)
	};
}

function buildOpenFoodFactsContext(product: OpenFoodFactsProduct) {
	return [
		`OFF product_name: ${normalizeText(product.product_name) || 'Unresolved Product'}`,
		`OFF brand(s): ${normalizeText(product.brands) || normalizeText(product.brand_owner) || 'Unresolved Brand'}`,
		`OFF generic_name: ${normalizeText(product.generic_name) || 'Unresolved Product Type'}`,
		`OFF categories: ${normalizeText(product.categories) || 'Unresolved Category'}`,
		`OFF countries: ${normalizeText(product.countries) || 'Unresolved Origin'}`,
		`OFF ingredients_text: ${normalizeText(product.ingredients_text) || 'Unresolved Ingredients'}`
	].join('\n');
}

async function lookupOpenFoodFactsProduct(barcode: string) {
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
	const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`barcode ${barcode}`)}&hl=en&gl=us&num=10&pws=0`;
	const response = await fetch(searchUrl, {
		headers: buildFetchHeaders()
	});

	const html = await response.text();
	console.log(`[verify] google_status=${response.status}`);
	console.log(`[verify] google_head=${html.slice(0, 200).replace(/\s+/g, ' ')}`);

	const $ = cheerio.load(html);

	const h3Records = $('h3')
		.slice(0, 5)
		.map((_, element) => normalizeText($(element).text()))
		.get()
		.filter(Boolean);

	const titleTags = $('title')
		.map((_, element) => normalizeText($(element).text()))
		.get()
		.filter(Boolean);

	const contextText = [...titleTags, ...h3Records].join('\n');

	return {
		blocked: response.status === 403 || response.status === 429,
		hasContext: Boolean(contextText),
		statusCode: response.status,
		contextText
	};
}

function fallbackCorporateResult(barcode: string): OpenRouterCorporateOutput {
	const prefix = getGs1RegistrationPrefix(barcode);
	const unresolvedProduct = `Unresolved Product ${barcode}`;
	return {
		barcode,
		product_identity: {
			verified_name: unresolvedProduct,
			brand: 'Unresolved Brand',
			verified_brand: 'Unresolved Brand',
			category: 'Unresolved Category',
			confidence_score: 0.5
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

async function callOpenRouterAnalyzer(args: {
	barcode: string;
	registryBlock: string;
	marketPulseBlock: string;
	corporateCrawlBlock: string;
	contextText: string;
	offProduct: OpenFoodFactsProduct | null;
	sourcesUsed: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'>;
}): Promise<OpenRouterCorporateOutput> {
	if (!env.OPENROUTER_API_KEY) {
		const fallback = fallbackCorporateResult(args.barcode);
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
	const offBrand =
		normalizeText(args.offProduct?.brands) || normalizeText(args.offProduct?.brand_owner) || 'Unresolved Brand';

	const systemPrompt = `PROTOCOL META:
id=ABSOLUTE_TRUTH_V15_FINAL
logic_engine=ADVERSARIAL_DATA_RECONCILIATION
instruction_handling=STRICT_ZERO_SUMMARIZATION. EXECUTE ATOMICALLY.

SYSTEM SETUP REQUIREMENT:
1) SEARCH_API_KEY must be active.
2) Populate all three truth bundle blocks before execution: <registry_block>, <market_pulse_block>, <corporate_block>.
3) If brand is identified, perform secondary ownership recursion using corporate evidence.

OBJECTIVE:
Eliminate metadata ghosts and recycled barcode errors. Reject registry data when it conflicts with live market pulse and map ownership to ultimate global holding company.

FORENSIC LOGIC GATES:
Gate 1 - Identity_Arbitration:
1) Compare <registry_block> (static) vs <market_pulse_block> (live).
2) If category conflicts, immediately discard registry as metadata ghost.
3) Live market pulse is ground truth for physical identity.

Gate 2 - Ownership_Recursion:
1) Identify ground-truth brand.
2) Trace using <corporate_block>: Brand -> Manufacturer -> Ultimate Global Parent.
3) Apply 2026 M&A overrides when applicable.
4) Ignore legacy registry owners after verified ownership change.

Gate 3 - Structural_Audit:
1) PREFIX: identify GS1 country of registration.
2) ORIGIN: extract made-in location from market snippets.
3) COMPLIANCE: set is_flagged=true if brand or parent has direct HQ, majority ownership, or mission-critical manufacturing in target region.

EXECUTION MANDATE:
1) Market pulse overrides registry 100% when category conflicts.
2) If registry and market are both missing, return error JSON requesting manual brand input.
3) Never mention Hormel or Justin's if snippets indicate SodaStream product.
4) Return valid minified JSON only.

OUTPUT JSON ONLY:
{
	"product_identity": {
		"verified_name": "string",
		"brand": "string",
		"category": "string",
		"confidence": 0.0
	},
	"origin_data": {
		"physical_origin": "string",
		"legal_prefix_country": "string"
	},
	"corporate_hierarchy": {
		"ultimate_parent": "string",
		"parent_hq_country": "string",
		"ownership_chain": "Brand -> Immediate Owner -> Global Holding Company"
	},
	"compliance": {
		"is_flagged": false,
		"reason": "string"
	},
	"arbitration_log": "string"
}`;

	const userPrompt = `BARCODE: ${args.barcode}
OFF_HINT_PRODUCT: ${offProductName}
OFF_HINT_BRAND: ${offBrand}
<registry_block>
${args.registryBlock || 'EMPTY_REGISTRY_BLOCK'}
</registry_block>
<market_pulse_block>
${args.marketPulseBlock || 'EMPTY_MARKET_PULSE_BLOCK'}
</market_pulse_block>
<corporate_block>
${args.corporateCrawlBlock || 'EMPTY_CORPORATE_CRAWL_BLOCK'}
</corporate_block>`;

	const response = await fetch(OPENROUTER_API_URL, {
		method: 'POST',
		headers: buildFetchHeaders({
			Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			'Content-Type': 'application/json',
			'HTTP-Referer': env.OPENROUTER_REFERER || 'http://localhost:5173',
			'X-Title': env.OPENROUTER_TITLE || 'Corporate Fact Checker'
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
		const fallback = fallbackCorporateResult(args.barcode);
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
		const holdingCompanyHq =
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

		if (brand.toLowerCase().includes('sodastream') && /(hormel|justin)/i.test(legalHoldingCompany)) {
			legalHoldingCompany = 'PepsiCo';
			arbitrationLog = `${arbitrationLog} Applied acquisition override: SodaStream mapped to PepsiCo using 2026 ownership context.`;
		}

		if (brand.toLowerCase().includes('nutella') && !/ferrero/i.test(legalHoldingCompany)) {
			legalHoldingCompany = 'Ferrero Group';
			arbitrationLog = `${arbitrationLog} Applied conglomerate override: Nutella mapped to Ferrero Group.`;
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

		return {
			barcode: args.barcode,
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
			product_name: productName,
			verified_brand: brand,
			brand,
			legal_holding_company: legalHoldingCompany,
			holding_company_hq: holdingCompanyHq,
			country_of_origin: originCountry,
			is_flagged: flagged,
			flag_reason: flagReason,
			confidence_score: confidence,
			source_attribution: sourceAttribution,
			data_sources_used: dataSourcesUsed,
			parent_company: legalHoldingCompany,
			origin_country: originCountry,
			reasoning: flagReason
		};
	} catch {
		const fallback = fallbackCorporateResult(args.barcode);
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
		product_identity: {
			verified_name: `Barcode ${cached.barcode}`,
			brand: normalizeText(cached.brand) || 'Unresolved Brand',
			verified_brand: normalizeText(cached.brand) || 'Unresolved Brand',
			category: cachedCategory,
			confidence_score: 0.95
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
		compliance: {
			is_flagged: Boolean(cached.is_flagged),
			flag_reason: Boolean(cached.is_flagged) ? 'Cached flagged result from Supabase.' : null
		},
		ownership_structure: {
			manufacturer: normalizeText(cached.brand) || 'Unresolved Manufacturer',
			ultimate_parent: normalizeText(cached.parent_company) || 'Unresolved Parent',
			parent_hq_country: cachedParentHq
		},
		compliance_status: {
			is_flagged: Boolean(cached.is_flagged),
			flag_reason: Boolean(cached.is_flagged) ? 'Cached flagged result from Supabase.' : null
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

async function cacheScanResult(result: {
	barcode: string;
	brand: string;
	legal_holding_company: string;
	country_of_origin: string;
	category: string;
	parent_hq_country: string;
	source_attribution: string;
	arbitration_log: string;
	is_flagged: boolean;
}) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const adminSupabase = getAdminSupabase() as any;
	const basePayload = {
		barcode: result.barcode,
		brand: result.brand,
		parent_company: result.legal_holding_company,
		origin_country: result.country_of_origin,
		is_flagged: result.is_flagged,
		updated_at: new Date().toISOString()
	};

	const extendedPayload = {
		...basePayload,
		category: result.category,
		parent_hq_country: result.parent_hq_country,
		source_attribution: result.source_attribution,
		arbitration_log: result.arbitration_log
	};

	let { error } = await adminSupabase.from('products').upsert(extendedPayload, { onConflict: 'barcode' });

	if (error) {
		console.warn('[verify] extended cache upsert failed, retrying base payload', error);
		const fallback = await adminSupabase.from('products').upsert(basePayload, { onConflict: 'barcode' });
		error = fallback.error;
	}

	if (error) {
		console.error('[verify] cache upsert failed', error);
		throw new Error('Failed to persist verification result to products cache.');
	}
}

async function robustScan(barcode: string): Promise<OpenRouterCorporateOutput> {
	const cached = await loadCachedProduct(barcode);
	if (cached) {
		return cached;
	}

	const offLookup = await lookupOpenFoodFactsProduct(barcode).catch(() => ({ product: null, statusCode: 0 }));
	let offProduct = offLookup.product;
	let offContext = offProduct ? buildOpenFoodFactsContext(offProduct) : '';
	const scrape = await semanticGoogleScrape(barcode).catch(() => ({
		blocked: true,
		hasContext: false,
		statusCode: 0,
		contextText: ''
	}));

	const marketPulseQuery = `${barcode} product name`;
	const marketPulse = await serperSearch(marketPulseQuery).catch(() => ({
		query: marketPulseQuery,
		contextText: '',
		statusCode: 0,
		used: false
	}));

	const offDomain = detectLikelyDomain(offContext);
	const scrapeDomain = detectLikelyDomain(scrape.contextText);
	if (
		offProduct &&
		offDomain !== 'unknown' &&
		scrapeDomain !== 'unknown' &&
		offDomain !== scrapeDomain
	) {
		offProduct = null;
		offContext = '';
	}

	const seedBrand = normalizeText(offProduct?.brands || offProduct?.brand_owner)
		.split(',')
		.map((v) => normalizeText(v))
		.find(Boolean);
	const corporateCrawlQuery = seedBrand
		? `Who owns ${seedBrand} ultimate parent company`
		: `Who owns barcode ${barcode} ultimate parent company`;
	const corporateCrawl = await serperSearch(corporateCrawlQuery).catch(() => ({
		query: corporateCrawlQuery,
		contextText: '',
		statusCode: 0,
		used: false
	}));

	const registryBlock = offContext || 'NO_REGISTRY_DATA';
	const marketPulseBlock = marketPulse.contextText || scrape.contextText || 'NO_MARKET_PULSE_DATA';
	const corporateCrawlBlock = corporateCrawl.contextText || 'NO_CORPORATE_CRAWL_DATA';

	if (!offContext && !marketPulse.contextText && !scrape.contextText) {
		const fallback = fallbackCorporateResult(barcode);
		return {
			...fallback,
			error:
				'Missing registry and market evidence. Please provide manual brand input to continue forensic ownership mapping.',
			arbitration_log:
				'No data in registry_block and market_pulse_block; returning error JSON and requesting manual brand input per protocol.'
		};
	}

	const mergedContext = [registryBlock, marketPulseBlock, corporateCrawlBlock].filter(Boolean).join('\n\n');
	const sourcesUsed: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'> = [];
	if (offProduct) sourcesUsed.push('OFF_API');
	if (scrape.hasContext || marketPulse.used || corporateCrawl.used) sourcesUsed.push('Search_Scrape');
	if (sourcesUsed.length === 0 || offLookup.statusCode === 404 || offLookup.statusCode === 406) {
		sourcesUsed.push('Internal_Knowledge');
	}

	const ai = await callOpenRouterAnalyzer({
		barcode,
		registryBlock,
		marketPulseBlock,
		corporateCrawlBlock,
		contextText: mergedContext,
		offProduct,
		sourcesUsed
	});

	await cacheScanResult({
		barcode: ai.barcode,
		brand: ai.brand,
		legal_holding_company: ai.legal_holding_company,
		country_of_origin: ai.country_of_origin,
		category: ai.product_identity.category,
		parent_hq_country: ai.corporate_structure.global_hq_country,
		source_attribution: ai.source_attribution,
		arbitration_log: ai.arbitration_log,
		is_flagged: ai.is_flagged
	});

	return ai;
}

export const POST: RequestHandler = async ({ request }) => {
	const headers = corsHeaders(request.headers.get('origin'));

	try {
		const body = (await request.json().catch(() => ({}))) as VerifyBody;
		const barcode = body.barcode?.trim();

		if (!barcode) {
			return json({ error: 'barcode is required' }, { status: 400, headers });
		}

		const result = await robustScan(barcode);
		return json(result, { headers });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal server error';
		console.error('[verify] POST failed', error);
		return json({ error: message }, { status: 500, headers });
	}
};
