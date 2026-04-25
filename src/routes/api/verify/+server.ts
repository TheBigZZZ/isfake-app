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
	product_name: string;
	brand: string;
	legal_holding_company: string;
	country_of_origin: string;
	is_flagged: boolean;
	flag_reason: string;
	confidence_score: number;
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
		product_name: `Barcode ${barcode}`,
		brand: 'UNKNOWN BRAND',
		legal_holding_company: 'UNKNOWN PARENT',
		country_of_origin: 'UNKNOWN',
		is_flagged: false,
		flag_reason: 'Search data is ambiguous; brand identified via internal knowledge.',
		confidence_score: 0.5,
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

	const systemPrompt = `ROLE: Corporate Fact-Checker.

OBJECTIVE:
- Extract the specific product and brand for barcode ${args.barcode}.
- Determine the ultimate legal holding company only.

MANDATORY PROCESS:
1) Identify the product_name and brand using OFF + search snippets.
2) Collision Error handling: if multiple famous separate brands appear in one snippet, split them into independent entities and pick only the brand matching this barcode.
3) Ignore retailer names and store chains (e.g., Walmart, Dollar General, Carrefour, Tesco) as holding companies.
4) Verify parent via internal corporate knowledge; if search snippets conflict with internal knowledge, prioritize verified internal parent mapping.
5) Return only the ultimate legal holding company (with legal suffix when known).

CONSTRAINTS:
- Never merge competitors unless explicit ownership syntax exists ("subsidiary of", "owned by").
- Never return a retailer as legal_holding_company.
- If confidence_score < 0.9, set flag_reason to include exactly: "Search data is ambiguous; brand identified via internal knowledge."

OUTPUT JSON ONLY:
{
  "barcode": "string",
  "product_name": "string",
  "brand": "string",
  "legal_holding_company": "string",
  "country_of_origin": "string",
  "is_flagged": boolean,
  "flag_reason": "string",
  "confidence_score": number,
  "data_sources_used": ["OFF_API", "Search_Scrape", "Internal_Knowledge"]
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
		const confidence =
			typeof parsed.confidence_score === 'number'
				? Math.max(0, Math.min(1, parsed.confidence_score))
				: 0.82;
		const productName = normalizeText(parsed.product_name) || offProductName || `Barcode ${args.barcode}`;
		const brand = normalizeText(parsed.brand) || offBrand || 'UNKNOWN BRAND';
		const legalHoldingCompany = normalizeText(parsed.legal_holding_company) || 'UNKNOWN PARENT';
		const originCountry = normalizeText(parsed.country_of_origin) || 'UNKNOWN';
		const ambiguousNote = 'Search data is ambiguous; brand identified via internal knowledge.';
		const flagReasonRaw = normalizeText(parsed.flag_reason);
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
			product_name: productName,
			brand,
			legal_holding_company: legalHoldingCompany,
			country_of_origin: originCountry,
			is_flagged: Boolean(parsed.is_flagged),
			flag_reason: flagReason,
			confidence_score: confidence,
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
		product_name: `Barcode ${cached.barcode}`,
		brand: normalizeText(cached.brand) || 'UNKNOWN BRAND',
		legal_holding_company: normalizeText(cached.parent_company) || 'UNKNOWN PARENT',
		country_of_origin: normalizeText(cached.origin_country) || 'UNKNOWN',
		is_flagged: Boolean(cached.is_flagged),
		flag_reason: 'Cached result from Supabase.',
		confidence_score: 0.95,
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
			product_name: `Barcode ${barcode}`,
			brand: 'SYSTEM PREFIX',
			legal_holding_company: 'UNKNOWN PARENT',
			country_of_origin: 'Israel',
			is_flagged: true,
			flag_reason: 'Barcode starts with 729, treated as GS1 Israeli hard-stop.',
			confidence_score: 1,
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
	const offContext = offLookup.product ? buildOpenFoodFactsContext(offLookup.product) : '';
	const scrape = await semanticGoogleScrape(barcode).catch(() => ({
		blocked: true,
		hasContext: false,
		statusCode: 0,
		contextText: ''
	}));

	const mergedContext = [offContext, scrape.contextText].filter(Boolean).join('\n\n');
	const sourcesUsed: Array<'OFF_API' | 'Search_Scrape' | 'Internal_Knowledge'> = [];
	if (offLookup.product) sourcesUsed.push('OFF_API');
	if (scrape.hasContext) sourcesUsed.push('Search_Scrape');
	if (sourcesUsed.length === 0 || offLookup.statusCode === 404 || offLookup.statusCode === 406) {
		sourcesUsed.push('Internal_Knowledge');
	}

	const ai = await callOpenRouterAnalyzer({
		barcode,
		contextText: mergedContext,
		offProduct: offLookup.product,
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
