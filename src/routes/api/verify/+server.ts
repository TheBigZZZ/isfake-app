import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import * as cheerio from 'cheerio';
import type { RequestHandler } from './$types';
import { getAdminSupabase } from '$lib/server/supabase';

type VerifyBody = {
	barcode?: string;
	action?: 'scan';
};

type OpenRouterAnalysisOutput = {
	brand: string;
	parent_company: string;
	origin_country: string;
	is_flagged: boolean;
	reasoning: string;
};

type CachedProductRow = {
	barcode: string;
	brand: string;
	parent_company: string;
	is_flagged: boolean;
};

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
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
			return normalizeText(`${titleText} ${anchorText}`);
		})
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

function neutralFallback(barcode: string) {
	return {
		barcode,
		brand: 'UNKNOWN BRAND',
		parent_company: 'UNKNOWN PARENT',
		origin_country: 'UNKNOWN',
		is_flagged: false,
		reasoning: 'No reliable analysis was available, so the result was left unflagged.'
	};
}

async function callOpenRouterAnalyzer(args: { barcode: string; contextText: string }): Promise<OpenRouterAnalysisOutput> {
	if (!env.OPENROUTER_API_KEY) {
		const fallback = neutralFallback(args.barcode);
		return {
			brand: fallback.brand,
			parent_company: fallback.parent_company,
			origin_country: fallback.origin_country,
			is_flagged: fallback.is_flagged,
			reasoning: `${fallback.reasoning} (OPENROUTER_API_KEY missing, using local fallback).`
		};
	}

	const prompt = `You are a global corporate analyst. Given a barcode ${args.barcode} and search text, identify the brand. Do not apply any regional priority filters.

Always trace the brand to its ultimate parent company.

If the search text identifies a retailer but the barcode belongs to a manufacturer, prioritize the manufacturer as the brand.

Return only JSON with this exact shape:
{ "brand": "string", "parent_company": "string", "origin_country": "string", "is_flagged": boolean, "reasoning": "string" }

Guidance:
- Use "UNKNOWN BRAND", "UNKNOWN PARENT", and "UNKNOWN" when evidence is insufficient.
- Set "is_flagged" to true only when the evidence supports Israeli ownership or control.
- Do not apply regional priority prefix rules.
- No markdown. JSON only.

Search Text:\n${args.contextText || 'EMPTY_CONTEXT'}`;

	const response = await fetch(OPENROUTER_API_URL, {
		method: 'POST',
		headers: buildFetchHeaders({
			Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			'Content-Type': 'application/json',
			'HTTP-Referer': env.OPENROUTER_REFERER || 'http://localhost:5173',
			'X-Title': env.OPENROUTER_TITLE || 'Global Brand Trace'
		}),
		body: JSON.stringify({
			model: OPENROUTER_MODEL,
			temperature: 0.1,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content:
						'Return only valid JSON. Do not wrap in markdown. Keep analysis concise and evidence-focused.'
				},
				{ role: 'user', content: prompt }
			]
		})
	});

	if (!response.ok) {
		const fallback = neutralFallback(args.barcode);
		return {
			brand: fallback.brand,
			parent_company: fallback.parent_company,
			origin_country: fallback.origin_country,
			is_flagged: fallback.is_flagged,
			reasoning: `${fallback.reasoning} (OpenRouter ${response.status} fallback).`
		};
	}

	const payload = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = payload.choices?.[0]?.message?.content ?? '';

	try {
		const parsed = JSON.parse(extractJsonObject(content)) as Partial<OpenRouterAnalysisOutput>;

		return {
			brand: normalizeText(parsed.brand) || 'UNKNOWN BRAND',
			parent_company: normalizeText(parsed.parent_company) || 'UNKNOWN PARENT',
			origin_country: normalizeText(parsed.origin_country) || 'UNKNOWN',
			is_flagged: Boolean(parsed.is_flagged),
			reasoning:
				normalizeText(parsed.reasoning) ||
				'AI returned JSON without an explicit explanation; defaulted to a conservative interpretation.'
		};
	} catch {
		const fallback = neutralFallback(args.barcode);
		return {
			brand: fallback.brand,
			parent_company: fallback.parent_company,
			origin_country: fallback.origin_country,
			is_flagged: fallback.is_flagged,
			reasoning: `${fallback.reasoning} (JSON parse fallback).`
		};
	}
}

async function loadCachedProduct(barcode: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const adminSupabase = getAdminSupabase() as any;
	const { data } = await adminSupabase
		.from('products')
		.select('barcode,brand,parent_company,is_flagged')
		.eq('barcode', barcode)
		.maybeSingle();

	if (!data) return null;

	const cached = data as CachedProductRow;

	return {
		barcode: cached.barcode,
		brand: cached.brand,
		parent_company: cached.parent_company,
		origin_country: 'UNKNOWN',
		is_flagged: Boolean(cached.is_flagged),
		reasoning: 'Cached result from Supabase.'
	};
}

async function cacheScanResult(result: {
	barcode: string;
	brand: string;
	parent_company: string;
	is_flagged: boolean;
}) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const adminSupabase = getAdminSupabase() as any;

	await adminSupabase.from('products').upsert(
		{
			barcode: result.barcode,
			brand: result.brand,
			parent_company: result.parent_company,
			is_flagged: result.is_flagged,
			updated_at: new Date().toISOString()
		},
		{ onConflict: 'barcode' }
	);
}

async function robustScan(barcode: string) {
	if (barcode.startsWith('729')) {
		return {
			barcode,
			brand: 'SYSTEM PREFIX',
			parent_company: 'UNKNOWN PARENT',
			origin_country: 'Israel',
			is_flagged: true,
			reasoning: 'Barcode starts with 729, so this is treated as a hard-stop Israeli prefix result.'
		};
	}

	const cached = await loadCachedProduct(barcode);
	if (cached) {
		return cached;
	}

	const scrape = await semanticGoogleScrape(barcode).catch(() => ({
		blocked: true,
		hasContext: false,
		statusCode: 0,
		contextText: ''
	}));

	const ai = await callOpenRouterAnalyzer({
		barcode,
		contextText: scrape.contextText
	});

	const result = {
		barcode,
		brand: ai.brand,
		parent_company: ai.parent_company,
		origin_country: ai.origin_country,
		is_flagged: ai.is_flagged,
		reasoning: ai.reasoning
	};

	await cacheScanResult(result);

	return result;
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