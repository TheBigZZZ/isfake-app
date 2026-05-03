import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

export { describe, it, expect, beforeEach, afterEach, vi };

/**
 * Mock Supabase client for testing
 */
export const createMockSupabaseClient = () => ({
	from: vi.fn().mockReturnValue({
		select: vi.fn().mockReturnThis(),
		update: vi.fn().mockReturnThis(),
		insert: vi.fn().mockReturnThis(),
		upsert: vi.fn().mockReturnThis(),
		delete: vi.fn().mockReturnThis(),
		eq: vi.fn().mockReturnThis(),
		maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
		single: vi.fn().mockResolvedValue({ data: null, error: null })
	}),
	auth: {
		admin: {
			createUser: vi.fn(),
			deleteUser: vi.fn()
		}
	}
});

/**
 * Mock fetch for API testing
 */
export const mockFetch = (responseData: unknown, status = 200) => {
	return vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: vi.fn().mockResolvedValue(responseData),
		text: vi.fn().mockResolvedValue(JSON.stringify(responseData)),
		headers: new Headers()
	});
};

/**
 * Create mock request context
 */
export const createMockRequestContext = (overrides = {}) => ({
	request: new Request('http://localhost:5173/api/test', {
		method: 'POST',
		headers: new Headers({
			'Content-Type': 'application/json',
			'Origin': 'http://localhost:5173'
		})
	}),
	locals: {
		user: null
	},
	...overrides
});

/**
 * Create mock user
 */
export const createMockUser = (overrides = {}) => ({
	id: 'test-user-123',
	email: 'test@example.com',
	user_metadata: {},
	...overrides
});

/**
 * Create mock scan result
 */
export const createMockScanResult = (overrides = {}) => ({
	barcode: '5012345678900',
	product: {
		verified_name: 'Test Product',
		name: 'Test Product',
		brand: 'Test Brand',
		ultimate_parent: 'Test Corp',
		parent: 'Test Corp',
		hq: 'United States',
		category: 'Food'
	},
	brand: 'Test Brand',
	parent_company: 'Test Corp',
	origin_country: 'United States',
	category: 'Food',
	is_flagged: false,
	confidence_score: 0.9,
	...overrides
});

/**
 * Wait for async operations
 */
export const waitFor = async (condition: () => boolean, timeout = 1000) => {
	const start = Date.now();
	while (!condition() && Date.now() - start < timeout) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!condition()) {
		throw new Error(`Condition not met within ${timeout}ms`);
	}
};

/**
 * Sleep utility
 */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
