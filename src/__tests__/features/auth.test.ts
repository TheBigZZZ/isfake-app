import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as jwt from 'jsonwebtoken';

// Mock the environment and imports
const JWT_SECRET = 'test-secret-key-for-jwt';
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;

/**
 * Helper functions (these will be tested)
 */
function extractJwtFromRequest(request: Request): string | null {
	const authHeader = request.headers.get('Authorization');
	if (authHeader?.startsWith('Bearer ')) {
		return authHeader.slice(7);
	}

	const cookies = request.headers.get('Cookie');
	if (cookies) {
		const match = cookies.match(/sb-access-token=([^;]+)/);
		if (match) return match[1];
	}

	return null;
}

function verifyJwt(token: string): Record<string, unknown> | null {
	try {
		return jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Test Suite: JWT Extraction
 */
describe('Authentication: JWT Extraction', () => {
	it('should extract JWT from Authorization header', () => {
		const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signature';
		const request = new Request('http://localhost/api/test', {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});

		const extracted = extractJwtFromRequest(request);
		expect(extracted).toBe(token);
	});

	it('should extract JWT from sb-access-token cookie', () => {
		const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.signature';
		const request = new Request('http://localhost/api/test', {
			headers: {
				Cookie: `sb-access-token=${token}; Path=/`
			}
		});

		const extracted = extractJwtFromRequest(request);
		expect(extracted).toBe(token);
	});

	it('should return null for missing token', () => {
		const request = new Request('http://localhost/api/test');
		const extracted = extractJwtFromRequest(request);
		expect(extracted).toBeNull();
	});

	it('should handle malformed Authorization header', () => {
		const request = new Request('http://localhost/api/test', {
			headers: {
				Authorization: 'InvalidFormat token'
			}
		});

		const extracted = extractJwtFromRequest(request);
		expect(extracted).toBeNull();
	});

	it('should prioritize Authorization header over cookie', () => {
		const headerToken = 'header-token';
		const cookieToken = 'cookie-token';
		const request = new Request('http://localhost/api/test', {
			headers: {
				Authorization: `Bearer ${headerToken}`,
				Cookie: `sb-access-token=${cookieToken}`
			}
		});

		const extracted = extractJwtFromRequest(request);
		expect(extracted).toBe(headerToken);
	});
});

/**
 * Test Suite: JWT Verification
 */
describe('Authentication: JWT Verification', () => {
	let validToken: string;
	let expiredToken: string;

	beforeEach(() => {
		// Create valid token
		validToken = jwt.sign(
			{
				sub: 'user-123',
				email: 'user@example.com',
				iat: Math.floor(Date.now() / 1000)
			},
			JWT_SECRET,
			{ expiresIn: '1h' }
		);

		// Create expired token
		expiredToken = jwt.sign(
			{
				sub: 'user-123',
				email: 'user@example.com',
				iat: Math.floor(Date.now() / 1000) - 7200 // 2 hours ago
			},
			JWT_SECRET,
			{ expiresIn: '1h' }
		);
	});

	it('should verify valid JWT', () => {
		const payload = verifyJwt(validToken);
		expect(payload).not.toBeNull();
		expect(payload?.sub).toBe('user-123');
		expect(payload?.email).toBe('user@example.com');
	});

	it('should reject expired token', () => {
		const payload = verifyJwt(expiredToken);
		expect(payload).toBeNull();
	});

	it('should reject token with wrong secret', () => {
		const wrongSecretToken = jwt.sign(
			{ sub: 'user-123', email: 'user@example.com' },
			'wrong-secret',
			{ expiresIn: '1h' }
		);

		const payload = verifyJwt(wrongSecretToken);
		expect(payload).toBeNull();
	});

	it('should reject malformed token', () => {
		const payload = verifyJwt('not.a.valid.token');
		expect(payload).toBeNull();
	});

	it('should reject empty token', () => {
		const payload = verifyJwt('');
		expect(payload).toBeNull();
	});

	it('should extract user ID from payload', () => {
		const payload = verifyJwt(validToken);
		expect(payload?.sub).toBeDefined();
		expect(typeof payload?.sub).toBe('string');
	});

	it('should handle custom claims in token', () => {
		const tokenWithClaims = jwt.sign(
			{
				sub: 'user-123',
				email: 'user@example.com',
				tier: 'supporter',
				permissions: ['read:scans', 'write:history']
			},
			JWT_SECRET,
			{ expiresIn: '1h' }
		);

		const payload = verifyJwt(tokenWithClaims);
		expect(payload?.tier).toBe('supporter');
		expect(Array.isArray(payload?.permissions)).toBe(true);
	});
});

/**
 * Test Suite: Request Context Extraction
 */
describe('Authentication: Request Context', () => {
	it('should extract user context from valid token', () => {
		const token = jwt.sign(
			{ sub: 'user-123', email: 'user@example.com' },
			JWT_SECRET,
			{ expiresIn: '1h' }
		);

		const request = new Request('http://localhost/api/test', {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});

		const extracted = extractJwtFromRequest(request);
		const payload = verifyJwt(extracted!);

		expect(payload).not.toBeNull();
		expect(payload?.sub).toBe('user-123');
	});

	it('should handle missing auth gracefully', () => {
		const request = new Request('http://localhost/api/test');
		const extracted = extractJwtFromRequest(request);
		expect(extracted).toBeNull();
	});
});

/**
 * Test Suite: Cookie Parsing Edge Cases
 */
describe('Authentication: Cookie Parsing', () => {
	it('should handle multiple cookies', () => {
		const token = 'test-token-value';
		const request = new Request('http://localhost/api/test', {
			headers: {
				Cookie: `session=abc123; sb-access-token=${token}; path=/; secure`
			}
		});

		const extracted = extractJwtFromRequest(request);
		expect(extracted).toBe(token);
	});

	it('should handle token at end of cookie string', () => {
		const token = 'test-token-at-end';
		const request = new Request('http://localhost/api/test', {
			headers: {
				Cookie: `session=abc123; sb-access-token=${token}`
			}
		});

		const extracted = extractJwtFromRequest(request);
		expect(extracted).toBe(token);
	});

	it('should not extract token with different name', () => {
		const request = new Request('http://localhost/api/test', {
			headers: {
				Cookie: `access-token=test; sb-refresh-token=other`
			}
		});

		const extracted = extractJwtFromRequest(request);
		expect(extracted).toBeNull();
	});
});
