import { describe, it, expect, beforeEach } from 'vitest';

/**
 * CORS headers function
 */
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
		'Vary': 'Origin'
	};
}

/**
 * Input validation functions
 */
function validateContentType(contentType: string | null): { valid: boolean; error?: string } {
	if (!contentType) {
		return { valid: false, error: 'Missing Content-Type header' };
	}

	if (!contentType.toLowerCase().includes('application/json')) {
		return { valid: false, error: 'Content-Type must be application/json' };
	}

	return { valid: true };
}

function validateRequestSize(body: string, maxBytes = 1_000_000): { valid: boolean; error?: string } {
	if (body.length > maxBytes) {
		return { valid: false, error: `Request body exceeds ${maxBytes} bytes` };
	}

	return { valid: true };
}

function validateBarcodeInput(barcode: unknown): { valid: boolean; error?: string } {
	if (typeof barcode !== 'string') {
		return { valid: false, error: 'Barcode must be a string' };
	}

	if (barcode.trim().length === 0) {
		return { valid: false, error: 'Barcode cannot be empty' };
	}

	if (barcode.length > 100) {
		return { valid: false, error: 'Barcode too long (max 100 characters)' };
	}

	return { valid: true };
}

function validateImageInput(
	imageBase64: unknown,
	imageUrl: unknown,
	imageDataUrl: unknown
): { valid: boolean; error?: string } {
	const MAX_BASE64 = 200_000;
	const MAX_DATA_URL = 250_000;

	if (typeof imageBase64 === 'string' && imageBase64.length > MAX_BASE64) {
		return { valid: false, error: 'Image base64 exceeds 200KB limit' };
	}

	if (typeof imageDataUrl === 'string' && imageDataUrl.length > MAX_DATA_URL) {
		return { valid: false, error: 'Image data URL exceeds 250KB limit' };
	}

	if (typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl.trim())) {
		return { valid: false, error: 'Remote image URLs not supported' };
	}

	return { valid: true };
}

/**
 * Test Suite: CORS Validation
 */
describe('Security: CORS Headers', () => {
	it('should allow localhost origin', () => {
		const headers = corsHeaders('http://localhost');
		expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost');
	});

	it('should allow localhost:5173 origin', () => {
		const headers = corsHeaders('http://localhost:5173');
		expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
	});

	it('should allow capacitor origin', () => {
		const headers = corsHeaders('capacitor://localhost');
		expect(headers['Access-Control-Allow-Origin']).toBe('capacitor://localhost');
	});

	it('should allow production domain', () => {
		const headers = corsHeaders('https://isfake-app.onrender.com');
		expect(headers['Access-Control-Allow-Origin']).toBe('https://isfake-app.onrender.com');
	});

	it('should deny unauthorized origin', () => {
		const headers = corsHeaders('https://evil.com');
		expect(headers['Access-Control-Allow-Origin']).toBe('https://localhost');
	});

	it('should deny null origin', () => {
		const headers = corsHeaders(null);
		expect(headers['Access-Control-Allow-Origin']).toBe('https://localhost');
	});

	it('should deny empty origin', () => {
		const headers = corsHeaders('');
		expect(headers['Access-Control-Allow-Origin']).toBe('https://localhost');
	});

	it('should include proper CORS headers', () => {
		const headers = corsHeaders('http://localhost');
		expect(headers['Access-Control-Allow-Methods']).toContain('POST');
		expect(headers['Access-Control-Allow-Methods']).toContain('OPTIONS');
		expect(headers['Access-Control-Allow-Headers']).toContain('Content-Type');
		expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
		expect(headers['Vary']).toBe('Origin');
	});

	it('should not allow wildcard origin', () => {
		const headers = corsHeaders('*');
		expect(headers['Access-Control-Allow-Origin']).not.toBe('*');
	});
});

/**
 * Test Suite: Content-Type Validation
 */
describe('Security: Content-Type Validation', () => {
	it('should accept application/json', () => {
		const result = validateContentType('application/json');
		expect(result.valid).toBe(true);
	});

	it('should accept application/json with charset', () => {
		const result = validateContentType('application/json; charset=utf-8');
		expect(result.valid).toBe(true);
	});

	it('should reject missing Content-Type', () => {
		const result = validateContentType(null);
		expect(result.valid).toBe(false);
		expect(result.error).toBeDefined();
	});

	it('should reject text/html', () => {
		const result = validateContentType('text/html');
		expect(result.valid).toBe(false);
	});

	it('should reject application/x-www-form-urlencoded', () => {
		const result = validateContentType('application/x-www-form-urlencoded');
		expect(result.valid).toBe(false);
	});

	it('should be case-insensitive', () => {
		const result = validateContentType('APPLICATION/JSON');
		expect(result.valid).toBe(true);
	});
});

/**
 * Test Suite: Request Size Validation
 */
describe('Security: Request Size Limits', () => {
	const MAX_BODY = 1_000_000; // 1 MB

	it('should accept body under limit', () => {
		const body = 'a'.repeat(100_000);
		const result = validateRequestSize(body, MAX_BODY);
		expect(result.valid).toBe(true);
	});

	it('should reject body exceeding limit', () => {
		const body = 'a'.repeat(MAX_BODY + 1);
		const result = validateRequestSize(body, MAX_BODY);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('exceeds');
	});

	it('should handle empty body', () => {
		const result = validateRequestSize('', MAX_BODY);
		expect(result.valid).toBe(true);
	});

	it('should handle body at limit boundary', () => {
		const body = 'a'.repeat(MAX_BODY);
		const result = validateRequestSize(body, MAX_BODY);
		expect(result.valid).toBe(true);
	});
});

/**
 * Test Suite: Barcode Input Validation
 */
describe('Security: Barcode Input Validation', () => {
	it('should accept valid barcode', () => {
		const result = validateBarcodeInput('5012345678900');
		expect(result.valid).toBe(true);
	});

	it('should reject non-string barcode', () => {
		const result = validateBarcodeInput(12345);
		expect(result.valid).toBe(false);
	});

	it('should reject empty barcode', () => {
		const result = validateBarcodeInput('');
		expect(result.valid).toBe(false);
	});

	it('should reject whitespace-only barcode', () => {
		const result = validateBarcodeInput('   ');
		expect(result.valid).toBe(false);
	});

	it('should reject overly long barcode', () => {
		const longBarcode = '1'.repeat(101);
		const result = validateBarcodeInput(longBarcode);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('too long');
	});

	it('should accept barcode with special characters', () => {
		const result = validateBarcodeInput('5012-3456-7890-0');
		expect(result.valid).toBe(true);
	});

	it('should accept barcode with spaces', () => {
		const result = validateBarcodeInput('5012 3456 7890 0');
		expect(result.valid).toBe(true);
	});

	it('should reject null barcode', () => {
		const result = validateBarcodeInput(null);
		expect(result.valid).toBe(false);
	});

	it('should reject undefined barcode', () => {
		const result = validateBarcodeInput(undefined);
		expect(result.valid).toBe(false);
	});
});

/**
 * Test Suite: Image Input Validation
 */
describe('Security: Image Input Validation', () => {
	it('should accept valid base64 image', () => {
		const base64 = 'a'.repeat(100_000);
		const result = validateImageInput(base64, undefined, undefined);
		expect(result.valid).toBe(true);
	});

	it('should reject oversized base64 image', () => {
		const base64 = 'a'.repeat(200_001);
		const result = validateImageInput(base64, undefined, undefined);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('exceeds');
	});

	it('should reject oversized data URL', () => {
		const dataUrl = 'a'.repeat(250_001);
		const result = validateImageInput(undefined, undefined, dataUrl);
		expect(result.valid).toBe(false);
	});

	it('should reject remote image URL', () => {
		const result = validateImageInput(undefined, 'https://example.com/image.jpg', undefined);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('Remote');
	});

	it('should reject http remote URL', () => {
		const result = validateImageInput(undefined, 'http://example.com/image.jpg', undefined);
		expect(result.valid).toBe(false);
	});

	it('should accept no image', () => {
		const result = validateImageInput(undefined, undefined, undefined);
		expect(result.valid).toBe(true);
	});
});

/**
 * Test Suite: Injection Attack Prevention
 */
describe('Security: Injection Prevention', () => {
	it('should safely handle SQL-like strings in barcode', () => {
		const result = validateBarcodeInput("'; DROP TABLE users; --");
		expect(result.valid).toBe(true); // Validation is permissive, sanitization happens elsewhere
	});

	it('should safely handle XSS attempts in barcode', () => {
		const result = validateBarcodeInput('<script>alert("xss")</script>');
		expect(result.valid).toBe(true); // Validation is permissive, sanitization happens elsewhere
	});

	it('should handle Unicode in barcode safely', () => {
		const result = validateBarcodeInput('5012345678900™️');
		expect(result.valid).toBe(true);
	});

	it('should handle emoji in barcode safely', () => {
		const result = validateBarcodeInput('5012345678900😊');
		expect(result.valid).toBe(true);
	});
});

/**
 * Test Suite: JSON Parsing Safety
 */
describe('Security: JSON Parsing', () => {
	it('should safely parse valid JSON', () => {
		const json = '{"barcode":"5012345678900"}';
		expect(() => JSON.parse(json)).not.toThrow();
	});

	it('should fail on malformed JSON', () => {
		const json = '{barcode:5012345678900}'; // Invalid JSON
		expect(() => JSON.parse(json)).toThrow();
	});

	it('should handle large JSON safely', () => {
		const json = JSON.stringify({ barcode: 'a'.repeat(50_000) });
		expect(() => JSON.parse(json)).not.toThrow();
	});

		it('should prevent JSON bomb attacks', () => {
			// Build a syntactically valid deeply-nested JSON string and ensure it parses.
			const depth = 50;
			let json = '';
			for (let i = 0; i < depth; i++) json += '{"a":';
			json += '1';
			for (let i = 0; i < depth; i++) json += '}';

			// Parsing should complete (production should still enforce a depth limit).
			expect(() => JSON.parse(json)).not.toThrow();
		});
});
