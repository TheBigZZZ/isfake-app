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

type OpenRouterCorporateOutput = {
	barcode: string;
	product_identity: {
		verified_brand: string;
		category: string;
		confidence_score: number;
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
};

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPEN_FOOD_FACTS_API_URL = 'https://world.openfoodfacts.org/api/v2/product';
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
	return 'Unknown';
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

function buildOpenFoodFactsContext(product: OpenFoodFactsProduct) {
	return [
		`OFF product_name: ${normalizeText(product.product_name) || 'UNKNOWN'}`,
		`OFF brand(s): ${normalizeText(product.brands) || normalizeText(product.brand_owner) || 'UNKNOWN'}`,
		`OFF generic_name: ${normalizeText(product.generic_name) || 'UNKNOWN'}`,
		`OFF categories: ${normalizeText(product.categories) || 'UNKNOWN'}`,
		`OFF countries: ${normalizeText(product.countries) || 'UNKNOWN'}`,
		`OFF ingredients_text: ${normalizeText(product.ingredients_text) || 'UNKNOWN'}`
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
	return {
		barcode,
		product_identity: {
			verified_brand: 'UNKNOWN BRAND',
			category: 'Unknown',
			confidence_score: 0.5
		},
		ownership_structure: {
			manufacturer: 'UNKNOWN MANUFACTURER',
			ultimate_parent: 'UNKNOWN PARENT',
			parent_hq_country: 'UNKNOWN'
		},
		compliance_status: {
			is_flagged: false,
			flag_reason: null
		},
		arbitration_log:
			'Insufficient corroborated evidence; defaulted to unknown identity using conservative arbitration rules.',
		product_name: `Barcode ${barcode}`,
		verified_brand: 'UNKNOWN BRAND',
		brand: 'UNKNOWN BRAND',
		legal_holding_company: 'UNKNOWN PARENT',
		holding_company_hq: 'UNKNOWN',
		country_of_origin: 'UNKNOWN',
		is_flagged: false,
		flag_reason: 'Search data is ambiguous; brand identified via internal knowledge.',
		confidence_score: 0.5,
		source_attribution: 'Internal_Knowledge',
		data_sources_used: ['Internal_Knowledge'],
		parent_company: 'UNKNOWN PARENT',
		origin_country: 'UNKNOWN',
		reasoning: 'Search data is ambiguous; brand identified via internal knowledge.'
	};
}

async function callOpenRouterAnalyzer(args: {
	barcode: string;
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

	const offProductName = normalizeText(args.offProduct?.product_name) || 'UNKNOWN';
	const offBrand =
		normalizeText(args.offProduct?.brands) || normalizeText(args.offProduct?.brand_owner) || 'UNKNOWN';

	const systemPrompt = `ROLE: Data Arbitrator for Corporate Ownership.

TASK OBJECTIVE:
- Identify product brand and ultimate parent company with maximum factual precision.
- Resolve contradictions between registry/API data and marketplace/scraper data.

AUDIT LOGIC GATES:
GATE 1 - Category_Consistency_Check
1) Extract functional category from all sources (for example Beverage, Electronics, Appliance).
2) If registry category conflicts with web-scrape/search category, assume GTIN collision or stale metadata.
3) Action: discard registry product identity and re-identify brand from high-entropy scrape snippets.

GATE 2 - Commercial_Entity_Filter
1) Identify brand owner in title/description context.
2) Check whether the entity is retailer/supermarket/distributor.
3) If yes, treat as distribution layer and pivot to the manufacturer.
4) If no, continue to ultimate global parent.

STRICT VERIFICATION RULES:
- Set is_flagged=true only if direct legal/structural evidence exists (HQ, >50% ownership, or primary manufacturing sites) for the specific identified manufacturer.
- Default must be is_flagged=false when evidence is absent.
- Do not anchor on a target name if evidence points to a non-target product.

OPERATIONAL CONSTRAINTS:
- Prioritize high-entropy scrape snippets over static registry metadata.
- Never infer parent-subsidiary relationships from visual similarity or shared distributors.
- If confidence_score < 0.7, explicitly state ambiguity in arbitration_log.

OUTPUT JSON ONLY:
{
	"product_identity": {
		"verified_brand": "string",
		"category": "string",
		"confidence_score": number
	},
	"ownership_structure": {
		"manufacturer": "string",
		"ultimate_parent": "string",
		"parent_hq_country": "string"
	},
	"compliance_status": {
		"is_flagged": boolean,
		"flag_reason": "string|null"
	},
	"arbitration_log": "string"
}`;

	const userPrompt = `BARCODE: ${args.barcode}
OFF_HINT_PRODUCT: ${offProductName}
OFF_HINT_BRAND: ${offBrand}

MERGED_CONTEXT:\n${args.contextText || 'EMPTY_CONTEXT'}`;

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
			typeof parsed.product_identity?.confidence_score === 'number'
				? parsed.product_identity.confidence_score
				: parsed.confidence_score;
		const confidence =
			typeof parsedConfidence === 'number' ? Math.max(0, Math.min(1, parsedConfidence)) : 0.82;
		const productName = normalizeText(parsed.product_name) || offProductName || `Barcode ${args.barcode}`;
		const brand =
			normalizeText(parsed.product_identity?.verified_brand || parsed.verified_brand || parsed.brand) ||
			offBrand ||
			'UNKNOWN BRAND';
		const category =
			normalizeText(parsed.product_identity?.category) ||
			domainToCategory(detectLikelyDomain(args.contextText));
		const manufacturer =
			normalizeText(parsed.ownership_structure?.manufacturer) ||
			brand ||
			'UNKNOWN MANUFACTURER';
		let legalHoldingCompany =
			normalizeText(parsed.ownership_structure?.ultimate_parent || parsed.legal_holding_company) ||
			'UNKNOWN PARENT';
		const holdingCompanyHq =
			normalizeText(parsed.ownership_structure?.parent_hq_country || parsed.holding_company_hq) || 'UNKNOWN';
		const originCountry = normalizeText(parsed.country_of_origin) || 'UNKNOWN';
		const ambiguousNote = 'Search data is ambiguous; brand identified via internal knowledge.';
		const sourceAttributionRaw = normalizeText(parsed.source_attribution);
		const sourceAttribution =
			sourceAttributionRaw && ['Internal_Knowledge', 'GS1_Registry', 'Search_Scrape'].includes(sourceAttributionRaw)
				? sourceAttributionRaw
				: args.sourcesUsed.includes('Search_Scrape')
					? 'Search_Scrape'
					: 'Internal_Knowledge';
		let flagReasonRaw =
			normalizeText(parsed.compliance_status?.flag_reason ?? parsed.flag_reason) ||
			'No direct documented structural link found.';
		let flagged = Boolean(parsed.compliance_status?.is_flagged ?? parsed.is_flagged);
		let arbitrationLog =
			normalizeText(parsed.arbitration_log) ||
			'Applied arbitration gates using available evidence and selected highest-confidence manufacturer path.';

		if (looksLikeRetailer(legalHoldingCompany) && !isPrivateLabelBrand(brand)) {
			legalHoldingCompany = 'UNKNOWN PARENT';
			flagReasonRaw = `${flagReasonRaw || 'Retailer/distributor name detected in ownership candidates.'} Retailer was treated as distributor and excluded.`;
			arbitrationLog = `${arbitrationLog} Overrode distribution-layer entity and pivoted to manufacturer ownership.`;
		}

		if (confidence < 0.7 && !arbitrationLog.toLowerCase().includes('ambigu')) {
			arbitrationLog = `${arbitrationLog} Ambiguity remains due to low confidence evidence.`;
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
				verified_brand: brand,
				category,
				confidence_score: confidence
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
	const { data } = await adminSupabase
		.from('products')
		.select('barcode,brand,parent_company,origin_country,is_flagged')
		.eq('barcode', barcode)
		.maybeSingle();

	if (!data) return null;

	const cached = data as CachedProductRow;

	return {
		barcode: cached.barcode,
		product_identity: {
			verified_brand: normalizeText(cached.brand) || 'UNKNOWN BRAND',
			category: 'Unknown',
			confidence_score: 0.95
		},
		ownership_structure: {
			manufacturer: normalizeText(cached.brand) || 'UNKNOWN MANUFACTURER',
			ultimate_parent: normalizeText(cached.parent_company) || 'UNKNOWN PARENT',
			parent_hq_country: 'UNKNOWN'
		},
		compliance_status: {
			is_flagged: Boolean(cached.is_flagged),
			flag_reason: Boolean(cached.is_flagged) ? 'Cached flagged result from Supabase.' : null
		},
		arbitration_log: 'Loaded from cache; prior arbitration details unavailable in cached schema.',
		product_name: `Barcode ${cached.barcode}`,
		verified_brand: normalizeText(cached.brand) || 'UNKNOWN BRAND',
		brand: normalizeText(cached.brand) || 'UNKNOWN BRAND',
		legal_holding_company: normalizeText(cached.parent_company) || 'UNKNOWN PARENT',
		holding_company_hq: 'UNKNOWN',
		country_of_origin: normalizeText(cached.origin_country) || 'UNKNOWN',
		is_flagged: Boolean(cached.is_flagged),
		flag_reason: 'Cached result from Supabase.',
		confidence_score: 0.95,
		source_attribution: 'Internal_Knowledge',
		data_sources_used: ['Internal_Knowledge'],
		parent_company: normalizeText(cached.parent_company) || 'UNKNOWN PARENT',
		origin_country: normalizeText(cached.origin_country) || 'UNKNOWN',
		reasoning: 'Cached result from Supabase.'
	};
}

async function cacheScanResult(result: {
	barcode: string;
	brand: string;
	legal_holding_company: string;
	country_of_origin: string;
	is_flagged: boolean;
}) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const adminSupabase = getAdminSupabase() as any;

	await adminSupabase.from('products').upsert(
		{
			barcode: result.barcode,
			brand: result.brand,
			parent_company: result.legal_holding_company,
			origin_country: result.country_of_origin,
			is_flagged: result.is_flagged,
			updated_at: new Date().toISOString()
		},
		{ onConflict: 'barcode' }
	);
}

async function robustScan(barcode: string): Promise<OpenRouterCorporateOutput> {
	if (barcode.startsWith('729')) {
		return {
			barcode,
			product_identity: {
				verified_brand: 'SYSTEM PREFIX',
				category: 'Unknown',
				confidence_score: 1
			},
			ownership_structure: {
				manufacturer: 'UNKNOWN MANUFACTURER',
				ultimate_parent: 'UNKNOWN PARENT',
				parent_hq_country: 'Israel'
			},
			compliance_status: {
				is_flagged: true,
				flag_reason: 'Barcode starts with 729, treated as GS1 Israeli hard-stop.'
			},
			arbitration_log: 'GS1 prefix hard-stop applied before external arbitration.',
			product_name: `Barcode ${barcode}`,
			verified_brand: 'SYSTEM PREFIX',
			brand: 'SYSTEM PREFIX',
			legal_holding_company: 'UNKNOWN PARENT',
			holding_company_hq: 'Israel',
			country_of_origin: 'Israel',
			is_flagged: true,
			flag_reason: 'Barcode starts with 729, treated as GS1 Israeli hard-stop.',
			confidence_score: 1,
			source_attribution: 'GS1_Registry',
			data_sources_used: ['Internal_Knowledge'],
			parent_company: 'UNKNOWN PARENT',
			origin_country: 'Israel',
			reasoning: 'Barcode starts with 729, treated as GS1 Israeli hard-stop.'
		};
	}

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

	const mergedContext = [offContext, scrape.contextText].filter(Boolean).join('\n\n');
	const sourcesUsed: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'> = [];
	if (offProduct) sourcesUsed.push('OFF_API');
	if (scrape.hasContext) sourcesUsed.push('Search_Scrape');
	if (sourcesUsed.length === 0 || offLookup.statusCode === 404 || offLookup.statusCode === 406) {
		sourcesUsed.push('Internal_Knowledge');
	}

	const ai = await callOpenRouterAnalyzer({
		barcode,
		contextText: mergedContext,
		offProduct,
		sourcesUsed
	});

	await cacheScanResult({
		barcode: ai.barcode,
		brand: ai.brand,
		legal_holding_company: ai.legal_holding_company,
		country_of_origin: ai.country_of_origin,
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
