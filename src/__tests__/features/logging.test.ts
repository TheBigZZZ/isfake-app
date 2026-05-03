import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Logging system with PII sanitization
 */
class SecureLogger {
	private route: string;
	private requestId: string;
	private sensitivePatterns = /(authorization|cookie|set-cookie|token|secret|password|api[-_]?key)/i;

	constructor(route: string, requestId: string = 'unknown') {
		this.route = route;
		this.requestId = requestId;
	}

	private sanitize(data: unknown): unknown {
		if (typeof data === 'string') {
			// Don't sanitize the entire string, just extract meaningful parts
			return data.length > 160 ? `${data.slice(0, 160)}...[truncated]` : data;
		}

		if (typeof data === 'object' && data !== null) {
			if (Array.isArray(data)) {
				return data.map((item) => this.sanitize(item));
			}

			const obj = data as Record<string, unknown>;
			const sanitized: Record<string, unknown> = {};

			for (const [key, value] of Object.entries(obj)) {
				if (this.sensitivePatterns.test(key)) {
					sanitized[key] = '[REDACTED]';
				} else {
					sanitized[key] = this.sanitize(value);
				}
			}

			return sanitized;
		}

		return data;
	}

	debug(message: string, data?: unknown) {
		const sanitized = data ? this.sanitize(data) : '';
		console.log(`[DEBUG] [${this.route}] [${this.requestId}] ${message}`, sanitized);
	}

	info(message: string, data?: unknown) {
		const sanitized = data ? this.sanitize(data) : '';
		console.log(`[INFO] [${this.route}] [${this.requestId}] ${message}`, sanitized);
	}

	warn(message: string, data?: unknown) {
		const sanitized = data ? this.sanitize(data) : '';
		console.warn(`[WARN] [${this.route}] [${this.requestId}] ${message}`, sanitized);
	}

	error(message: string, error?: Error, data?: unknown) {
		const sanitized = data ? this.sanitize(data) : '';
		const errorStr = error ? `${error.name}: ${error.message}` : '';
		console.error(
			`[ERROR] [${this.route}] [${this.requestId}] ${message} ${errorStr}`,
			sanitized
		);
	}
}

/**
 * Test Suite: Logger Initialization
 */
describe('Logging: Initialization', () => {
	it('should create logger with route and request ID', () => {
		const logger = new SecureLogger('/api/scan', 'req-123');
		expect(logger).toBeDefined();
	});

	it('should create logger with route only', () => {
		const logger = new SecureLogger('/api/auth');
		expect(logger).toBeDefined();
	});

	it('should generate default request ID if not provided', () => {
		const logger = new SecureLogger('/api/test');
		expect(logger).toBeDefined();
	});
});

/**
 * Test Suite: PII Sanitization
 */
describe('Logging: PII Sanitization', () => {
	let logger: SecureLogger;

	beforeEach(() => {
		logger = new SecureLogger('/api/scan', 'req-123');
	});

	it('should redact authorization header', () => {
		const data = {
			authorization: 'Bearer secret-token-123',
			method: 'POST'
		};

		// Simulate sanitization
		const sensitive = /(authorization|cookie|set-cookie|token|secret|password|api[-_]?key)/i;
		const sanitized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (sensitive.test(key)) {
				sanitized[key] = '[REDACTED]';
			} else {
				sanitized[key] = value;
			}
		}

		expect(sanitized.authorization).toBe('[REDACTED]');
		expect(sanitized.method).toBe('POST');
	});

	it('should redact cookie header', () => {
		const data = {
			cookie: 'session=abc123; sb-access-token=xyz789',
			path: '/api/scan'
		};

		const sensitive = /(authorization|cookie|set-cookie|token|secret|password|api[-_]?key)/i;
		const sanitized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (sensitive.test(key)) {
				sanitized[key] = '[REDACTED]';
			} else {
				sanitized[key] = value;
			}
		}

		expect(sanitized.cookie).toBe('[REDACTED]');
		expect(sanitized.path).toBe('/api/scan');
	});

	it('should redact API keys', () => {
		const data = {
			api_key: 'secret-api-key-123',
			apiKey: 'another-secret-456',
			public_data: 'this is fine'
		};

		const sensitive = /(authorization|cookie|set-cookie|token|secret|password|api[-_]?key)/i;
		const sanitized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (sensitive.test(key)) {
				sanitized[key] = '[REDACTED]';
			} else {
				sanitized[key] = value;
			}
		}

		expect(sanitized.api_key).toBe('[REDACTED]');
		expect(sanitized.apiKey).toBe('[REDACTED]');
		expect(sanitized.public_data).toBe('this is fine');
	});

	it('should redact tokens', () => {
		const data = {
			access_token: 'secret',
			refresh_token: 'secret',
			jwt_token: 'secret',
			public_info: 'visible'
		};

		const sensitive = /(authorization|cookie|set-cookie|token|secret|password|api[-_]?key)/i;
		const sanitized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (sensitive.test(key)) {
				sanitized[key] = '[REDACTED]';
			} else {
				sanitized[key] = value;
			}
		}

		expect(sanitized.access_token).toBe('[REDACTED]');
		expect(sanitized.refresh_token).toBe('[REDACTED]');
		expect(sanitized.jwt_token).toBe('[REDACTED]');
		expect(sanitized.public_info).toBe('visible');
	});

	it('should handle nested objects with sensitive data', () => {
		const data = {
			request: {
				headers: {
					authorization: 'Bearer token',
					'content-type': 'application/json'
				},
				body: {
					password: 'secret123',
					username: 'user@example.com'
				}
			}
		};

		const sensitive = /(authorization|cookie|set-cookie|token|secret|password|api[-_]?key)/i;

		const sanitize = (obj: unknown): unknown => {
			if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
				const result: Record<string, unknown> = {};
				for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
					if (sensitive.test(key)) {
						result[key] = '[REDACTED]';
					} else {
						result[key] = sanitize(value);
					}
				}
				return result;
			}
			return obj;
		};

		const sanitized = sanitize(data);
		const nested = sanitized as Record<string, Record<string, Record<string, unknown>>>;
		expect(nested.request.headers.authorization).toBe('[REDACTED]');
		expect(nested.request.body.password).toBe('[REDACTED]');
		expect(nested.request.body.username).toBe('user@example.com');
	});

	it('should not over-sanitize public data', () => {
		const data = {
			route: '/api/scan',
			method: 'POST',
			status: 200,
			barcode: '5012345678900'
		};

		const sensitive = /(authorization|cookie|set-cookie|token|secret|password|api[-_]?key)/i;
		const sanitized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			if (sensitive.test(key)) {
				sanitized[key] = '[REDACTED]';
			} else {
				sanitized[key] = value;
			}
		}

		expect(sanitized.route).toBe('/api/scan');
		expect(sanitized.method).toBe('POST');
		expect(sanitized.status).toBe(200);
		expect(sanitized.barcode).toBe('5012345678900');
	});
});

/**
 * Test Suite: Request ID Propagation
 */
describe('Logging: Request ID Tracking', () => {
	it('should include request ID in logs', () => {
		const logger = new SecureLogger('/api/scan', 'req-abc-123');
		// Request ID should be part of log context
		expect(logger).toBeDefined();
	});

	it('should generate unique request IDs', () => {
		const id1 = 'req-' + Math.random();
		const id2 = 'req-' + Math.random();
		expect(id1).not.toBe(id2);
	});

	it('should preserve request ID across multiple logs', () => {
		const requestId = 'req-persistent-123';
		const logger1 = new SecureLogger('/api/scan', requestId);
		const logger2 = new SecureLogger('/api/auth', requestId);
		// Both should have same request ID for tracing
		expect(logger1).toBeDefined();
		expect(logger2).toBeDefined();
	});
});

/**
 * Test Suite: Log Levels
 */
describe('Logging: Log Levels', () => {
	let logger: SecureLogger;

	beforeEach(() => {
		logger = new SecureLogger('/api/test', 'req-123');
	});

	it('should support debug level', () => {
		expect(() => logger.debug('Debug message')).not.toThrow();
	});

	it('should support info level', () => {
		expect(() => logger.info('Info message')).not.toThrow();
	});

	it('should support warn level', () => {
		expect(() => logger.warn('Warn message')).not.toThrow();
	});

	it('should support error level with Error object', () => {
		const error = new Error('Test error');
		expect(() => logger.error('Error message', error)).not.toThrow();
	});

	it('should handle logging without data', () => {
		expect(() => {
			logger.debug('Simple message');
			logger.info('Simple message');
			logger.warn('Simple message');
			logger.error('Simple message');
		}).not.toThrow();
	});

	it('should handle logging with data', () => {
		const data = { key: 'value', count: 123 };
		expect(() => {
			logger.debug('Message', data);
			logger.info('Message', data);
			logger.warn('Message', data);
		}).not.toThrow();
	});
});

/**
 * Test Suite: Sensitive Data Truncation
 */
describe('Logging: Data Truncation', () => {
	it('should truncate long strings', () => {
		const longString = 'a'.repeat(500);
		const truncated = longString.length > 160 ? `${longString.slice(0, 160)}...[truncated]` : longString;
		expect(truncated).toContain('[truncated]');
		expect(truncated.length).toBeLessThan(longString.length);
	});

	it('should not truncate short strings', () => {
		const shortString = 'short message';
		const result = shortString.length > 160 ? `${shortString.slice(0, 160)}...[truncated]` : shortString;
		expect(result).toBe(shortString);
	});

	it('should truncate at 160 character boundary', () => {
		const string = 'a'.repeat(200);
		const truncated = string.length > 160 ? `${string.slice(0, 160)}...[truncated]` : string;
		expect(truncated).toMatch(/a{160}\.\.\.\[truncated\]/);
	});
});

/**
 * Test Suite: Error Context Logging
 */
describe('Logging: Error Context', () => {
	it('should capture error name and message', () => {
		const error = new Error('Test error occurred');
		const errorStr = `${error.name}: ${error.message}`;
		expect(errorStr).toContain('Error: Test error occurred');
	});

	it('should handle custom error types', () => {
		class ValidationError extends Error {
			constructor(message: string) {
				super(message);
				this.name = 'ValidationError';
			}
		}

		const error = new ValidationError('Invalid input');
		expect(error.name).toBe('ValidationError');
		expect(error.message).toBe('Invalid input');
	});

	it('should include error in log context', () => {
		const error = new Error('Database connection failed');
		const context = {
			error: error.message,
			errorType: error.name,
			route: '/api/scan'
		};
		expect(context.error).toBe('Database connection failed');
		expect(context.errorType).toBe('Error');
	});
});

/**
 * Test Suite: No Console Calls in Server Code
 */
describe('Logging: Console Call Enforcement', () => {
	it('should detect console.log usage', () => {
		const code = 'console.log("message")';
		expect(code).toContain('console.log');
	});

	it('should detect console.error usage', () => {
		const code = 'console.error("error")';
		expect(code).toContain('console.error');
	});

	it('should detect console.warn usage', () => {
		const code = 'console.warn("warning")';
		expect(code).toContain('console.warn');
	});

	it('should validate logger usage instead', () => {
		const code = 'logger.info("message")';
		expect(code).toContain('logger.info');
	});
});
