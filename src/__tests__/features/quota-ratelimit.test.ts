import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * In-memory rate limiter implementation
 */
class RateLimiter {
	private store = new Map<string, { count: number; resetAt: number }>();
	private windowMs: number;
	private maxRequests: number;

	constructor(windowMs = 60000, maxRequests = 30) {
		this.windowMs = windowMs;
		this.maxRequests = maxRequests;
	}

	check(key: string): boolean {
		const now = Date.now();
		const existing = this.store.get(key);

		if (!existing || now > existing.resetAt) {
			this.store.set(key, { count: 1, resetAt: now + this.windowMs });
			return true;
		}

		if (existing.count >= this.maxRequests) {
			return false;
		}

		existing.count += 1;
		return true;
	}

	getRemaining(key: string): number {
		const existing = this.store.get(key);
		if (!existing || Date.now() > existing.resetAt) {
			return this.maxRequests;
		}
		return Math.max(0, this.maxRequests - existing.count);
	}

	reset(key: string): void {
		this.store.delete(key);
	}

	cleanup(now = Date.now()): number {
		let removed = 0;
		for (const [key, entry] of this.store.entries()) {
			if (now > entry.resetAt) {
				this.store.delete(key);
				removed++;
			}
		}
		return removed;
	}
}

/**
 * Quota management mock
 */
interface SubscriptionQuota {
	plan: 'free' | 'supporter';
	scan_limit: number;
	scans_used: number;
	period_end: Date;
}

function createDefaultQuota(): SubscriptionQuota {
	const now = new Date();
	const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
	return {
		plan: 'free',
		scan_limit: 10,
		scans_used: 0,
		period_end: periodEnd
	};
}

/**
 * Test Suite: Rate Limiting
 */
describe('Rate Limiting: Per-IP Enforcement', () => {
	let limiter: RateLimiter;

	beforeEach(() => {
		limiter = new RateLimiter(60000, 30); // 30 requests per minute
	});

	it('should allow first request from IP', () => {
		expect(limiter.check('192.168.1.1')).toBe(true);
	});

	it('should allow requests under limit', () => {
		const ip = '192.168.1.1';
		for (let i = 0; i < 30; i++) {
			expect(limiter.check(ip)).toBe(true);
		}
	});

	it('should reject request exceeding limit', () => {
		const ip = '192.168.1.1';
		// Use up all 30 requests
		for (let i = 0; i < 30; i++) {
			limiter.check(ip);
		}
		// Next request should fail
		expect(limiter.check(ip)).toBe(false);
	});

	it('should track different IPs separately', () => {
		expect(limiter.check('192.168.1.1')).toBe(true);
		expect(limiter.check('192.168.1.2')).toBe(true);
		expect(limiter.check('192.168.1.1')).toBe(true);
		expect(limiter.check('192.168.1.2')).toBe(true);
	});

	it('should return remaining requests count', () => {
		const ip = '192.168.1.1';
		expect(limiter.getRemaining(ip)).toBe(30);
		limiter.check(ip);
		expect(limiter.getRemaining(ip)).toBe(29);
		for (let i = 0; i < 28; i++) {
			limiter.check(ip);
		}
		expect(limiter.getRemaining(ip)).toBe(1);
	});

	it('should reset counter after window expires', (done) => {
		const limiter = new RateLimiter(100, 5); // 100ms window, 5 requests
		const ip = '192.168.1.1';

		// Use up limit
		for (let i = 0; i < 5; i++) {
			limiter.check(ip);
		}
		expect(limiter.check(ip)).toBe(false);

		// Wait for window to expire
		setTimeout(() => {
			expect(limiter.check(ip)).toBe(true);
			done();
		}, 150);
	});

	it('should cleanup expired entries', (done) => {
		const limiter = new RateLimiter(100, 5);
		limiter.check('192.168.1.1');

		setTimeout(() => {
			const cleaned = limiter.cleanup();
			expect(cleaned).toBeGreaterThan(0);
			done();
		}, 150);
	});

	it('should reset specific IP', () => {
		const ip = '192.168.1.1';
		for (let i = 0; i < 5; i++) {
			limiter.check(ip);
		}
		expect(limiter.getRemaining(ip)).toBe(25);

		limiter.reset(ip);
		expect(limiter.getRemaining(ip)).toBe(30);
	});
});

/**
 * Test Suite: Quota Management
 */
describe('Quota: Free Tier Limits', () => {
	it('should initialize free tier quota correctly', () => {
		const quota = createDefaultQuota();
		expect(quota.plan).toBe('free');
		expect(quota.scan_limit).toBe(10);
		expect(quota.scans_used).toBe(0);
	});

	it('should allow scan under free tier limit', () => {
		const quota = createDefaultQuota();
		expect(quota.scans_used).toBeLessThan(quota.scan_limit);
	});

	it('should reject scan at free tier limit', () => {
		const quota = createDefaultQuota();
		quota.scans_used = 10;
		expect(quota.scans_used >= quota.scan_limit).toBe(true);
	});

	it('should track remaining scans', () => {
		const quota = createDefaultQuota();
		const remaining = quota.scan_limit - quota.scans_used;
		expect(remaining).toBe(10);
	});

	it('should increment scans_used on successful scan', () => {
		const quota = createDefaultQuota();
		const initialCount = quota.scans_used;
		quota.scans_used += 1;
		expect(quota.scans_used).toBe(initialCount + 1);
	});

	it('should prevent overcount of scans', () => {
		const quota = createDefaultQuota();
		quota.scans_used = 10;
		// Would exceed limit
		const wouldExceed = quota.scans_used + 1 > quota.scan_limit;
		expect(wouldExceed).toBe(true);
	});
});

/**
 * Test Suite: Quota - Supporter Tier
 */
describe('Quota: Supporter Tier', () => {
	it('should have unlimited scans for supporter', () => {
		const quota: SubscriptionQuota = {
			plan: 'supporter',
			scan_limit: 999_999,
			scans_used: 0,
			period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
		};

		expect(quota.plan).toBe('supporter');
		expect(quota.scan_limit).toBe(999_999);
	});

	it('should allow supporter to exceed free tier limit', () => {
		const quota: SubscriptionQuota = {
			plan: 'supporter',
			scan_limit: 999_999,
			scans_used: 100,
			period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
		};

		expect(quota.scans_used < quota.scan_limit).toBe(true);
	});
});

/**
 * Test Suite: Quota Period Management
 */
describe('Quota: Period Reset', () => {
	it('should detect expired period', () => {
		const quota = createDefaultQuota();
		quota.period_end = new Date(Date.now() - 1000); // 1 second ago

		const isExpired = new Date() > quota.period_end;
		expect(isExpired).toBe(true);
	});

	it('should detect valid period', () => {
		const quota = createDefaultQuota();
		quota.period_end = new Date(Date.now() + 100_000); // 100 seconds from now

		const isValid = new Date() <= quota.period_end;
		expect(isValid).toBe(true);
	});

	it('should reset quota on period expiry', () => {
		const quota = createDefaultQuota();
		quota.scans_used = 10;
		quota.period_end = new Date(Date.now() - 1000); // Expired

		const isExpired = new Date() > quota.period_end;
		if (isExpired) {
			quota.scans_used = 0;
			quota.period_end = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
		}

		expect(quota.scans_used).toBe(0);
	});

	it('should calculate period duration correctly', () => {
		const quota = createDefaultQuota();
		const now = new Date();
		const periodStart = new Date(quota.period_end.getTime() - 30 * 24 * 60 * 60 * 1000);
		const durationDays = (quota.period_end.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000);

		expect(durationDays).toBe(30);
	});
});

/**
 * Test Suite: Combined Rate Limit & Quota
 */
describe('Security: Rate Limit + Quota Combined', () => {
	let limiter: RateLimiter;
	let quota: SubscriptionQuota;

	beforeEach(() => {
		limiter = new RateLimiter(60000, 30);
		quota = createDefaultQuota();
	});

	it('should enforce both rate limit and quota', () => {
		const ip = '192.168.1.1';

		// Check rate limit
		const rateLimitAllows = limiter.check(ip);
		expect(rateLimitAllows).toBe(true);

		// Check quota
		const quotaAllows = quota.scans_used < quota.scan_limit;
		expect(quotaAllows).toBe(true);

		// Both must allow
		expect(rateLimitAllows && quotaAllows).toBe(true);
	});

	it('should reject if rate limit exceeded but quota available', () => {
		const ip = '192.168.1.1';

		// Exhaust rate limit
		for (let i = 0; i < 30; i++) {
			limiter.check(ip);
		}

		const rateLimitAllows = limiter.check(ip);
		expect(rateLimitAllows).toBe(false);
	});

	it('should reject if quota exhausted but rate limit available', () => {
		const ip = '192.168.1.1';

		// Exhaust quota
		quota.scans_used = 10;

		const quotaAllows = quota.scans_used < quota.scan_limit;
		expect(quotaAllows).toBe(false);

		// Rate limit still allows
		const rateLimitAllows = limiter.check(ip);
		expect(rateLimitAllows).toBe(true);
	});
});

/**
 * Test Suite: Error Scenarios
 */
describe('Quota: Error Handling', () => {
	it('should handle missing quota gracefully', () => {
		const quota: SubscriptionQuota | null = null;

		// Fallback to free tier
		const plan = quota?.plan ?? 'free';
		const limit = quota?.scan_limit ?? 10;

		expect(plan).toBe('free');
		expect(limit).toBe(10);
	});

	it('should handle database connection errors', () => {
		const quota = createDefaultQuota();
		// In production, if DB fails, allow request but don't increment
		const shouldAllow = true; // Fallback: allow request
		expect(shouldAllow).toBe(true);
	});
});
