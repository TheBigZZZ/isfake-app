import { beforeAll, afterEach, vi } from 'vitest';

// Global test setup

/**
 * Mock environment variables
 */
beforeAll(() => {
	process.env.VITE_SENTRY_DSN = 'https://test@sentry.io/test';
	process.env.OPENROUTER_API_KEY = 'test-key';
	process.env.SEARCH_API_KEY = 'test-key';
	process.env.SUPABASE_JWT_SECRET = 'test-secret-key-for-jwt';
	process.env.NODE_ENV = 'test';
});

/**
 * Clear all mocks between tests
 */
afterEach(() => {
	vi.clearAllMocks();
});

/**
 * Mock global fetch if needed
 */
if (!globalThis.fetch) {
	globalThis.fetch = vi.fn();
}
