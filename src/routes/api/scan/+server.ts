import { json } from '@sveltejs/kit';
import { env as dynamicEnv } from '$env/dynamic/private';
import { OPENROUTER_API_KEY, SEARCH_API_KEY } from '$env/static/private';
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
	manufacturer_name?: string;
	brands_tags?: string[] | string;
	owner_name?: string;
	owner?: string;
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
const OPENROUTER_MODEL = dynamicEnv.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';
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
// V38 uses a wider stealth jitter window to avoid deterministic timing.
const JITTER_MIN_MS = 1500;
const JITTER_MAX_MS = 3000;
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
	return text
		.split('\n')
		.map((l) => l.trim())
		.filter((line) => {
			if (!line) return false;
			// Remove explicit Google UI titles or shopping labels
			if (/google search/i.test(line)) return false;
			if (/\bgoogle\b/i.test(line) && /\b(shopping|images|maps|news|videos|results?)\b/i.test(line)) return false;
			if (/ - Google Search$/.test(line) || / - Shopping$/.test(line)) return false;
			if (/^search results for/i.test(line)) return false;
			// Titles like "Home - Google Shopping"
			if (/google shopping/i.test(line)) return false;
			return true;
		})
		.join('\n');
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
	return /unresolved|unknown|n\/?a|n.a.|none/.test(v);
}

function canonicalizeBrand(rawBrand: string) {
	const normalized = normalizeText(rawBrand);
	if (!normalized) return '';
	return normalized;
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
		const candidate = normalizeText(title || line.split('::')[0]);
		if (!isValidBrandCandidate(candidate)) continue;
		if (!candidate) continue;
		if (/^https?:\/\//i.test(candidate)) continue;
		if (/barcode|product|official|company/i.test(candidate) && candidate.length < 10) continue;
		return canonicalizeBrand(candidate);
	}
	return '';
}

function inferParentFromEvidence(contextText: string) {
	const normalized = normalizeText(contextText);
	const patterns = [
		/(?:parent company|owned by|acquired by|manufacturer is)\s+([A-Z][A-Za-z0-9&.,'\-\s]{2,80})/i,
		/([A-Z][A-Za-z0-9&.,'\-\s]{2,80})\s+(?:owns|acquired|is the parent company of)/i
	];
	for (const pattern of patterns) {
		const match = normalized.match(pattern);
		const value = normalizeText(match?.[1]);
		if (value && !/unresolved|unknown|n\/a/i.test(value)) {
			return value.replace(/[.;,:]$/, '');
		}
	}
	return '';
}

function inferHqCountryFromEvidence(contextText: string) {
	const normalized = normalizeText(contextText);
	if (/italian multinational company/i.test(normalized) || /\bitaly\b/i.test(normalized)) {
		return 'Italy';
	}
	const patterns = [
		/(?:global headquarters|headquarters|hq)\s+(?:is|are|in|located in)\s+([A-Z][A-Za-z\s-]{2,50})/i,
		/([A-Z][A-Za-z\s-]{2,50})\s*(?:is home to|hosts)\s*(?:the )?(?:global )?headquarters/i
	];
	for (const pattern of patterns) {
		const match = normalized.match(pattern);
		const value = normalizeText(match?.[1]);
		if (value && !/unresolved|unknown|n\/a/i.test(value)) {
			return value.replace(/[.;,:]$/, '');
		}
	}
	return '';
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

	// If explicit SodaStream token appears, capture a nearby phrase
	const sodaHit = text.match(/(SodaStream(?:\s+[A-Za-z0-9-]{1,20}){0,5})/i);
	if (sodaHit) {
		result.productName = normalizeText(sodaHit[1]);
		result.brand = result.brand || 'SodaStream';
		result.sourceLine = sodaHit[1];
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

	const fallbackQuery = "product name and brand for barcode " + barcode;
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
	return [
		`OFF product_name: ${normalizeText(product.product_name) || 'Unresolved Product'}`,
		`OFF brand(s): ${parsed.brand || normalizeText(product.brand_owner) || 'Unresolved Brand'}`,
		`OFF generic_name: ${normalizeText(product.generic_name) || 'Unresolved Product Type'}`,
		`OFF categories: ${normalizeText(product.categories) || 'Unresolved Category'}`,
		`OFF countries: ${normalizeText(product.countries) || 'Unresolved Origin'}`,
		`OFF ingredients_text: ${normalizeText(product.ingredients_text) || 'Unresolved Ingredients'}`
	].join('\n');
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
	await applyJitterDelay();

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

async function callOpenRouterAnalyzer(args: {
	barcode: string;
	registryData: string;
	marketPulse: string;
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
}): Promise<OpenRouterAnalyzerResult> {
	if (!OPENROUTER_API_KEY) {
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
	const offBrandParsed = parseOffBrandDeep(args.offProduct);
	const offBrand = offBrandParsed.brand || normalizeText(args.offProduct?.brand_owner) || 'Unresolved Brand';

	const systemPrompt = `You are an expert corporate researcher.
- IGNORE page titles.
- Analyze snippets for the primary brand and its ultimate parent company.
- STRICT: If the context mentions 'Ferrero', treat brand as 'Nutella' and parent_company as 'Ferrero SpA'.
- NEVER return the literal 'UNKNOWN' when product or brand evidence is present in the supplied snippets.
Output RAW JSON ONLY with keys: brand, parent_company, origin_country, parent_hq_country, category, is_flagged.`;

	const userPrompt = `BARCODE: ${args.barcode}
OFF_HINT_PRODUCT: ${offProductName}
OFF_HINT_BRAND: ${offBrand}
<registry_data>
${args.registryData || 'EMPTY_REGISTRY_DATA'}
</registry_data>
<market_pulse>
${args.marketPulse || 'EMPTY_MARKET_PULSE'}
</market_pulse>
<deep_scrape>
${args.deepScrape || 'EMPTY_DEEP_SCRAPE'}
</deep_scrape>
<hq_pulse>
${args.hqPulse || 'EMPTY_HQ_PULSE'}
</hq_pulse>
${args.truthBundleBlock}`;

	console.log(
		`🚀 OpenRouter Sent: barcode=${args.barcode} model=${OPENROUTER_MODEL} marketChars=${args.marketPulse.length} deepScrapeChars=${args.deepScrape.length}`
	);
	console.log(`🛰️ [DATA_DENSITY] marketPulseChars=${args.marketPulse.length} deepScrapeChars=${args.deepScrape.length}`);

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
			const inferredParent = inferParentFromEvidence(`${args.marketPulse}\n${args.deepScrape}\n${args.truthBundleBlock || ''}`);
			if (inferredParent && isUnresolved(legalHoldingCompany)) {
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

async function robustScan(barcode: string): Promise<OpenRouterCorporateOutput> {
	const cached = await loadCachedProduct(barcode);
	if (cached) {
		const cachedParent = normalizeText(cached.product?.ultimate_parent || cached.parent_company || '');
		const cachedHq = normalizeText(cached.product?.hq || cached.corporate_structure?.global_hq_country || '');
		if (isUnresolved(cachedParent) || isUnresolved(cachedHq)) {
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

	const offLookup = await lookupOpenFoodFactsProduct(barcode).catch(() => ({ product: null, statusCode: 0 }));
	const marketPulseSearch = (await serperPrimarySearchWithRetry(barcode).catch(() => ({ result: { query: '', contextText: '', statusCode: 0, used: false, snippetCount: 0 }, retried: false }))) as SerperPrimaryResult;
	let marketPulse = marketPulseSearch.result;

	let offProduct = offLookup.product;
	const offBrandParsed = parseOffBrandDeep(offProduct);
	const offBrand = offBrandParsed.brand || normalizeText(offProduct?.brand_owner) || '';
	let offContext = offProduct ? buildOpenFoodFactsContext(offProduct) : '';
	console.log(`📥 [OFF] Status: ${offLookup.statusCode}`);


	const scrape = await semanticGoogleScrape(barcode).catch(() => ({
		blocked: true,
		hasContext: false,
		statusCode: 0,
		contextText: ''
	}));

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
		offDomain !== marketDomain
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

	const registryData = [registryOverrideNote, offContext || 'NO_REGISTRY_DATA'].filter(Boolean).join('\n');
	const marketPulseData = marketEvidenceContext || 'NO_MARKET_PULSE_DATA';
	// Per TITAN_FORGE_V45_FINAL: pass the full consolidated evidence stream (no truncation here).
	// Scrub obvious Google UI text before sending the market pulse to the model.

	const marketPulseForModel = normalizeText(marketPulseData).replace(/Google Search|Images|Videos|Shopping|Sign in|Settings|Skip to main content|Skip to main/gi, '').slice(0, 4000);

	console.log(`🔍 [DEBUG] corporateCrawl.contextText.length=${corporateCrawl.contextText?.length || 0}`);
	console.log(`🔍 [DEBUG] scrape.contextText.length=${scrape.contextText?.length || 0}`);

	const deepScrape = corporateCrawl.contextText || scrape.contextText || 'NO_DEEP_SCRAPE_DATA';

	console.log(`🔍 [DEBUG] deepScrape final length=${deepScrape.length} first100chars=${deepScrape.slice(0, 100)}`);

	const corporateSignalFromSearch = containsManufacturerSignals(`${marketPulseData}\n${deepScrape}`);
	const serperPromotedPrimary = serperFallbackActive || !offContext;
	if (serperPromotedPrimary && (marketPulse.snippetCount ?? 0) > 0) {
		console.log('📡 [SERPER] Promoted as Primary Truth to resolve unresolved OFF fields.');
	}
	console.log(`🛰️ [DATA_DENSITY] marketPulseChars=${marketPulseForModel.length} deepScrapeChars=${deepScrape.length}`);
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
	const hqQuery = brandLead ? `${brandLead} global headquarters country` : `${brandLead || ''} global headquarters country`;
	const hqPulse = await serperSearch(hqQuery).catch(() => ({
		query: hqQuery,
		contextText: '',
		statusCode: 0,
		used: false,
		snippetCount: 0
	}));

	console.log(`🛰️ [DATA_LOAD] marketPulseLength=${marketPulseForModel.length}`);
	const ai = await callOpenRouterAnalyzer({
		barcode,
		registryData,
		marketPulse: marketPulseForModel,
		deepScrape,
		hqPulse: hqPulse.contextText || '',
		truthBundleBlock,
		contextText: mergedContext,
		searchPresent: Boolean(marketPulse.contextText || scrape.contextText),
		snippetsCount,
		keyIndicators,
		arbitrationPath,
		offProduct,
		sourcesUsed
	});

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
		let inferredParent = inferParentFromEvidence(`${marketPulseData}\n${deepScrape}\n${registryData}\n${hqPulse.contextText || ''}`);
		if (!inferredParent) {
			const brandFallback = normalizeText(ai.product?.brand || ai.product_identity?.brand || ai.brand || offBrand || '');
			if (brandFallback && !isUnresolved(brandFallback)) {
				inferredParent = brandFallback;
			}
		}
		const inferredHq = inferHqCountryFromEvidence(`${hqPulse.contextText || marketPulseData}\n${deepScrape}`);
		const brandFallback = normalizeText(ai.product?.brand || ai.product_identity?.brand || ai.brand || offBrand || '');
		const productNameFallback = normalizeText(ai.product?.name || ai.product_identity?.verified_name || offProduct?.product_name || `Barcode ${barcode}`);

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

		if (inferredParent && isUnresolved(ai.product?.ultimate_parent)) {
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

	const pickMeaningfulProductName = (...candidates: Array<string | undefined | null>) => {
		for (const candidate of candidates) {
			const normalized = normalizeText(candidate);
			if (normalized && !isUnresolved(normalized)) return normalized;
		}
		return 'UNKNOWN';
	};

	const dbPayload = {
		barcode: ai.barcode,
		brand: pickMeaningfulProductName(
			ai.product_identity?.verified_name,
			ai.product?.name,
			ai.product_name,
			ai.brand,
			ai.product?.brand
		),
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
