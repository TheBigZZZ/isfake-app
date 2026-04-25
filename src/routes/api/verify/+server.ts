import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import * as cheerio from 'cheerio';
import type { RequestHandler } from './$types';
import type { VoteAction } from '$lib/verification';
import { voteOnBarcode } from '$lib/server/origin-verifier';
import { getAdminSupabase } from '$lib/server/supabase';

type VerifyBody = {
	barcode?: string;
	action?: 'scan' | 'verify' | 'correct';
	is_israeli?: boolean;
	name?: string;
	brand?: string;
	context_text?: string;
	reasoning?: string;
	confidence?: number;
};

type OpenRouterDataCleanerOutput = {
	success: boolean;
	brand: string;
	name?: string;
	is_israeli: boolean;
	reason: string;
	confidence?: number;
};

type OpenFoodFactsProduct = {
	product_name?: string;
	brands?: string;
	brand_owner?: string;
	generic_name?: string;
	quantity?: string;
	categories?: string;
	countries?: string;
	ingredients_text?: string;
	labels?: string;
	packaging?: string;
	image_front_url?: string;
	image_url?: string;
	nova_group?: string;
	nutriscore_grade?: string;
	ecoscore_grade?: string;
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
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
		{
			error: 'GET method not allowed. Use POST /api/verify with JSON body: { "barcode": "..." }.'
		},
		{
			status: 405,
			headers: {
				...corsHeaders(request.headers.get('origin')),
				Allow: 'POST, OPTIONS'
			}
		}
	);
};

function normalizeText(value: string | null | undefined) {
	return (value ?? '').replace(/\s+/g, ' ').trim();
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

function buildOpenFoodFactsContext(product: OpenFoodFactsProduct) {
	const lines = [
		`Product name: ${normalizeText(product.product_name) || 'UNKNOWN PRODUCT'}`,
		`Brand(s): ${normalizeText(product.brands) || normalizeText(product.brand_owner) || 'UNKNOWN BRAND'}`,
		`Generic name: ${normalizeText(product.generic_name) || 'N/A'}`,
		`Quantity: ${normalizeText(product.quantity) || 'N/A'}`,
		`Categories: ${normalizeText(product.categories) || 'N/A'}`,
		`Countries: ${normalizeText(product.countries) || 'N/A'}`,
		`Ingredients: ${normalizeText(product.ingredients_text) || 'N/A'}`,
		`Labels: ${normalizeText(product.labels) || 'N/A'}`,
		`Packaging: ${normalizeText(product.packaging) || 'N/A'}`,
		`Nutri-Score: ${normalizeText(product.nutriscore_grade) || 'N/A'}`,
		`Eco-Score: ${normalizeText(product.ecoscore_grade) || 'N/A'}`,
		`Nova group: ${normalizeText(product.nova_group) || 'N/A'}`
	];

	return lines.join('\n');
}

async function lookupOpenFoodFactsProduct(barcode: string) {
	const response = await fetch(`${OPEN_FOOD_FACTS_API_URL}/${encodeURIComponent(barcode)}.json`, {
		headers: {
			Accept: 'application/json',
			'User-Agent': GOOGLE_MOBILE_USER_AGENT
		}
	});

	if (!response.ok) {
		return null;
	}

	const payload = (await response.json()) as {
		status?: number;
		product?: OpenFoodFactsProduct;
	};

	if (payload.status !== 1 || !payload.product) {
		return null;
	}

	return payload.product;
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

function inferBrandFromContext(contextText: string) {
	const lowered = contextText.toLowerCase();

	if (lowered.includes('unilever')) return 'Unilever';
	if (lowered.includes('procter') || lowered.includes('p&g') || lowered.includes('pg')) {
		return 'Procter & Gamble';
	}
	if (lowered.includes('nestl') || lowered.includes('nestlé')) return 'Nestle';

	const titleHint = contextText
		.split('\n')
		.map((line) => normalizeText(line))
		.find((line) => line.length > 4);

	if (!titleHint) return '';
	const firstWord = titleHint.split(' ')[0] ?? '';
	return normalizeText(firstWord);
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
		.slice(0, 3)
		.map((_, element) => {
			const h3 = $(element);
			const titleText = normalizeText(h3.text());
			const anchor = h3.closest('a');
			const anchorText = normalizeText(anchor.text());
			const combinedText = normalizeText(`${titleText} ${anchorText}`);
			return combinedText || '';
		})
		.get()
		.filter(Boolean);

	const spanSnippets = $('span')
		.map((_, element) => normalizeText($(element).text()))
		.get()
		.filter((text) => text.split(/\s+/).length > 10);

	const titleTags = $('title')
		.map((_, element) => normalizeText($(element).text()))
		.get()
		.filter(Boolean);

	let contextText = [...titleTags, ...h3Records, ...spanSnippets].join('\n');
	if (!contextText) {
		contextText = normalizeText($('body').text()).slice(0, 500);
	}

	return {
		blocked: response.status === 403 || response.status === 429,
		hasContext: Boolean(contextText),
		statusCode: response.status,
		contextText
	};
}

function prefixKnowledgeFallback(barcode: string) {
	if (barcode.startsWith('729')) {
		return {
			name: `Barcode ${barcode}`,
			brand: 'SYSTEM PREFIX',
			is_israeli: true,
			reason: 'Prefix 729 fast-pass indicates Israeli origin.',
			confidence: 1
		};
	}

	if (barcode.startsWith('894')) {
		return {
			name: `Barcode ${barcode}`,
			brand: 'UNKNOWN BRAND',
			is_israeli: false,
			reason: 'Prefix 894 indicates non-Israeli origin unless stronger evidence indicates otherwise.',
			confidence: 0.35
		};
	}

	return {
		name: `Barcode ${barcode}`,
		brand: 'UNKNOWN BRAND',
		is_israeli: false,
		reason: 'No scrape context available; using conservative prefix heuristics and common industry patterns.',
		confidence: 0.2
	};
}

async function callOpenRouterDataCleaner(args: {
	barcode: string;
	contextText: string;
	knowledgeOnly: boolean;
}): Promise<OpenRouterDataCleanerOutput> {
	if (!env.OPENROUTER_API_KEY) {
		const fallback = prefixKnowledgeFallback(args.barcode);
		return {
			success: true,
			brand: fallback.brand,
			name: fallback.name,
			is_israeli: fallback.is_israeli,
			reason: `${fallback.reason} (OPENROUTER_API_KEY missing, using local fallback).`,
			confidence: fallback.confidence
		};
	}

	const deepReasonPrompt = `I have a barcode ${args.barcode}. My scraper was blocked. Using your internal knowledge of global trade and barcode standards, identify the brand for this code and its country of origin. If you are unsure, state 'Unknown' and trigger the Crowdsourcing state.`;

	const prompt = args.knowledgeOnly
		? `${deepReasonPrompt}

Output strictly in JSON format: { "success": true, "brand": "...", "is_israeli": boolean, "reason": "..." }.
Optional keys allowed: "name", "confidence".
No markdown. JSON only.`
		: `I am providing raw, messy HTML/text from a search result for barcode ${args.barcode}. Your job is to act as a Data Cleaner.

You are an expert in global commerce. I am giving you a barcode and some messy search text.
Even if the text is incomplete, use the Barcode Prefix and any keywords to identify the Brand.
If you see Unilever, P&G, or Nestle, you MUST identify them.
Do not return Unknown if there is any evidence of a brand name.

If a brand is owned by a massive multinational like Unilever, identify its origin based on its global headquarters (UK/Netherlands).

Identify the Product Name and Brand.
Use your internal 2026 knowledge to check for Israeli ownership.

Output strictly in JSON format: { "success": true, "brand": "...", "is_israeli": boolean, "reason": "..." }.
Optional keys allowed: "name", "confidence".
Do not output markdown, explanations, or any text outside the JSON object.

Context Block:\n${args.contextText || 'EMPTY_CONTEXT'}`;

	const response = await fetch(OPENROUTER_API_URL, {
		method: 'POST',
		headers: buildFetchHeaders({
			Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			'Content-Type': 'application/json',
			'HTTP-Referer': env.OPENROUTER_REFERER || 'http://localhost:5173',
			'X-Title': env.OPENROUTER_TITLE || 'Israel Checker'
		}),
		body: JSON.stringify({
			model: OPENROUTER_MODEL,
			temperature: 0.1,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content:
						'Return only valid JSON. Do not wrap in markdown. Keep decisions concise and evidence-focused.'
				},
				{ role: 'user', content: prompt }
			]
		})
	});

	if (!response.ok) {
		const fallback = prefixKnowledgeFallback(args.barcode);
		return {
			success: true,
			brand: fallback.brand,
			name: fallback.name,
			is_israeli: fallback.is_israeli,
			reason: `${fallback.reason} (OpenRouter ${response.status} fallback).`,
			confidence: fallback.confidence
		};
	}

	const payload = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = payload.choices?.[0]?.message?.content ?? '';

	try {
		const parsed = JSON.parse(extractJsonObject(content)) as Partial<OpenRouterDataCleanerOutput>;
		const inferredBrand = inferBrandFromContext(args.contextText);
		const brand = normalizeText(parsed.brand);
		const resolvedBrand =
			(!brand || brand.toLowerCase() === 'unknown') && inferredBrand ? inferredBrand : brand || 'UNKNOWN BRAND';
		const reason = normalizeText(parsed.reason);
		const resolvedReason =
			reason ||
			(inferredBrand
				? `Brand inferred from scraped evidence: ${inferredBrand}.`
				: 'AI returned JSON without explicit reason; defaulted to conservative interpretation.');

		return {
			success: parsed.success !== false,
			brand: resolvedBrand,
			name: normalizeText(parsed.name) || `Barcode ${args.barcode}`,
			is_israeli: Boolean(parsed.is_israeli),
			reason: resolvedReason,
			confidence:
				typeof parsed.confidence === 'number'
					? Math.max(0, Math.min(1, parsed.confidence))
					: args.knowledgeOnly
						? 0.35
						: 0.6
		};
	} catch {
		const fallback = prefixKnowledgeFallback(args.barcode);
		return {
			success: true,
			brand: fallback.brand,
			name: fallback.name,
			is_israeli: fallback.is_israeli,
			reason: `${fallback.reason} (JSON parse fallback).`,
			confidence: fallback.confidence
		};
	}
}

async function loadCachedProduct(barcode: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const adminSupabase = getAdminSupabase() as any;
	const { data } = await adminSupabase
		.from('products')
		.select('barcode,name,brand,is_israeli,status,confidence,reasoning,context_text')
		.eq('barcode', barcode)
		.maybeSingle();

	if (!data) return null;

	return {
		barcode: data.barcode,
		name: data.name,
		brand: data.brand,
		context_text: data.context_text,
		reasoning: data.reasoning,
		is_israeli: Boolean(data.is_israeli),
		confidence: Number(data.confidence ?? 0.6),
		status: data.status === 'verified' ? 'verified' : 'pending',
		source: 'cached',
		needs_review: data.status !== 'verified',
		vote_count: 0,
		verify_votes: 0,
		correct_votes: 0
	};
}

async function cacheScanResult(result: {
	barcode: string;
	name: string;
	brand: string;
	context_text: string;
	reasoning: string;
	is_israeli: boolean;
	confidence: number;
	status: 'verified' | 'pending' | 'review';
}) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const adminSupabase = getAdminSupabase() as any;

	await adminSupabase.from('products').upsert(
		{
			barcode: result.barcode,
			name: result.name,
			brand: result.brand,
			is_israeli: result.is_israeli,
			status: result.status === 'verified' ? 'verified' : 'pending',
			confidence: result.confidence,
			reasoning: result.reasoning,
			context_text: result.context_text,
			updated_at: new Date().toISOString()
		},
		{ onConflict: 'barcode' }
	);
}

async function robustScan(barcode: string) {
	if (barcode.startsWith('729')) {
		return {
			barcode,
			name: `Barcode ${barcode}`,
			brand: 'SYSTEM PREFIX',
			context_text: 'Fast-pass prefix rule applied.',
			reasoning: 'Barcode starts with 729, hardcoded as Israeli-owned.',
			is_israeli: true,
			confidence: 1,
			status: 'verified',
			source: 'fast-pass',
			needs_review: false
		};
	}

	const openFoodFactsProduct = await lookupOpenFoodFactsProduct(barcode).catch(() => null);
	const openFoodFactsContext = openFoodFactsProduct ? buildOpenFoodFactsContext(openFoodFactsProduct) : '';

	const cached = await loadCachedProduct(barcode);
	if (cached && !openFoodFactsProduct) {
		return cached;
	}

	const scrape = await semanticGoogleScrape(barcode).catch(() => ({
		blocked: true,
		hasContext: false,
		statusCode: 0,
		contextText: ''
	}));

	const mergedContextText = [openFoodFactsContext, scrape.contextText].filter(Boolean).join('\n\n');
	const knowledgeOnly = scrape.blocked || (!scrape.hasContext && !openFoodFactsContext) || mergedContextText.length < 50;
	const ai = await callOpenRouterDataCleaner({
		barcode,
		contextText: mergedContextText,
		knowledgeOnly
	});

	const confidence = Math.max(0, Math.min(1, ai.confidence ?? (knowledgeOnly ? 0.35 : 0.6)));
	const needsReview = knowledgeOnly || confidence < 0.55;
	const offName = normalizeText(openFoodFactsProduct?.product_name) || `Barcode ${barcode}`;
	const offBrand =
		normalizeText(openFoodFactsProduct?.brands) || normalizeText(openFoodFactsProduct?.brand_owner) || 'UNKNOWN BRAND';
	const source = openFoodFactsProduct ? 'openfoodfacts+openrouter' : knowledgeOnly ? 'fallback' : 'openrouter';
	const result = {
		barcode,
		name: ai.name || offName,
		brand: ai.brand || offBrand,
		context_text: mergedContextText,
		reasoning: ai.reason,
		is_israeli: ai.is_israeli,
		confidence,
		status: needsReview ? 'review' : 'pending',
		source,
		needs_review: needsReview,
		vote_count: 0,
		verify_votes: 0,
		correct_votes: 0
	} as const;

	await cacheScanResult(result);

	return result;
}

export const POST: RequestHandler = async ({ request }) => {
	const headers = corsHeaders(request.headers.get('origin'));
	const body = (await request.json().catch(() => ({}))) as VerifyBody;
	const barcode = body.barcode?.trim();

	if (!barcode) {
		return json({ error: 'barcode is required' }, { status: 400, headers });
	}

	if (body.action === 'verify' || body.action === 'correct') {
		if (typeof body.is_israeli !== 'boolean') {
			return json({ error: 'is_israeli is required for votes' }, { status: 400, headers });
		}

		const result = await voteOnBarcode({
			barcode,
			isIsraeli: body.is_israeli,
			voteAction: body.action as VoteAction,
			name: body.name,
			brand: body.brand,
			contextText: body.context_text,
			reasoning: body.reasoning,
			confidence: body.confidence
		});

		return json(result, { headers });
	}

	const result = await robustScan(barcode);
	return json(result, { headers });
};