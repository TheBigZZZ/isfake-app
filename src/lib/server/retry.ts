import * as Sentry from '@sentry/sveltekit';
import { createServerLogger } from '$lib/server/logger';

export interface RetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	backoffMultiplier?: number;
	timeout?: number;
	shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
	maxAttempts: 3,
	baseDelayMs: 500,
	maxDelayMs: 5000,
	backoffMultiplier: 2,
	timeout: 30000,
	shouldRetry: (error) => {
		// Retry on network errors, timeouts, and 5xx errors
		if (error instanceof Error) {
			const message = error.message.toLowerCase();
			if (message.includes('timeout') || message.includes('network') || message.includes('econnrefused')) {
				return true;
			}
		}
		return false;
	}
};

/**
 * Retry a promise-based operation with exponential backoff
 */
export async function withRetry<T>(
	fn: (attempt: number) => Promise<T>,
	options: RetryOptions = {}
): Promise<T> {
	const config = { ...DEFAULT_OPTIONS, ...options };
	let lastError: unknown;

	for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
		try {
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`Request timeout after ${config.timeout}ms`)), config.timeout)
			);

			const result = await Promise.race([fn(attempt), timeoutPromise]);
			return result;
		} catch (error) {
			lastError = error;

			// Log each attempt
			if (attempt < config.maxAttempts) {
				const shouldRetry = config.shouldRetry(error, attempt);
				if (!shouldRetry) {
					// Don't retry if shouldRetry returns false
					break;
				}

				// Calculate exponential backoff with jitter
				const delayMs = Math.min(
					config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
					config.maxDelayMs
				);
				const jitterMs = Math.random() * delayMs * 0.1; // 10% jitter
				const totalDelayMs = delayMs + jitterMs;

				createServerLogger('lib.retry').warn(`Attempt ${attempt} failed, retrying in ${Math.round(totalDelayMs)}ms`, {
					details: { message: error instanceof Error ? error.message : String(error), attempt }
				});

				await sleep(totalDelayMs);
			}
		}
	}

	// All attempts failed
	Sentry.captureException(lastError, {
		tags: { context: 'retry_exhausted' },
		extra: { maxAttempts: config.maxAttempts }
	});

	throw lastError;
}

/**
 * Retry wrapper for fetch calls
 */
export async function fetchWithRetry(
	url: string,
	options?: RequestInit & { retryOptions?: RetryOptions }
): Promise<Response> {
	const { retryOptions, ...fetchOptions } = options || {};

	return withRetry(
		async () => {
			const response = await fetch(url, fetchOptions);

			// Treat 5xx errors as retriable
			if (response.status >= 500) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			return response;
		},
		{
			...retryOptions,
			shouldRetry: (error, attempt) => {
				// Retry on network errors and 5xx
				if (error instanceof Error) {
					return error.message.includes('HTTP') && error.message.includes('5');
				}
				return (retryOptions?.shouldRetry?.(error, attempt) ?? true);
			}
		}
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
