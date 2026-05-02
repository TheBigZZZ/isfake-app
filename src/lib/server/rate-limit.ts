import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { createServerLogger } from '$lib/server/logger';

const SCAN_RATE_LIMIT_PREFIX = 'isfake:scan-ip';
const SCAN_RATE_LIMIT_WINDOW = '1 m';
const SCAN_RATE_LIMIT_MAX = 30;
const SCAN_RATE_LIMIT_TIMEOUT_MS = 2000;

// If true, when Upstash/Redis is unavailable, fail-closed (reject requests) instead of using
// instance-local fallbacks which can be bypassed in multi-instance deployments.
const IS_PRODUCTION = (process.env.NODE_ENV || '').toLowerCase() === 'production';
const AUTH_RATE_LIMIT_FAIL_CLOSED =
	(process.env.AUTH_RATE_LIMIT_FAIL_CLOSED || (IS_PRODUCTION ? 'true' : 'false')) === 'true';

let scanRateLimiter: Ratelimit | null = null;

function getScanRateLimiter() {
	if (!scanRateLimiter) {
		scanRateLimiter = new Ratelimit({
			redis: Redis.fromEnv(),
			limiter: Ratelimit.slidingWindow(SCAN_RATE_LIMIT_MAX, SCAN_RATE_LIMIT_WINDOW),
			analytics: true,
			prefix: SCAN_RATE_LIMIT_PREFIX
		});
	}

	return scanRateLimiter;
}

function timeout<T>(ms: number, message = 'Rate limit request timed out') {
	return new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

type CheckResult = { allowed: boolean; fallback: boolean; reason?: string };

class EmergencyLocalLimiter {
	private windowMs: number;
	private max: number;
	private buckets: Map<string, { start: number; count: number }> = new Map();

	constructor(max: number, windowMs: number) {
		this.max = max;
		this.windowMs = windowMs;
	}

	allow(key: string) {
		const now = Date.now();
		const b = this.buckets.get(key);
		if (!b || now - b.start >= this.windowMs) {
			this.buckets.set(key, { start: now, count: 1 });
			return true;
		}

		if (b.count < this.max) {
			b.count += 1;
			return true;
		}

		return false;
	}
}

const LOCAL_WINDOW_MS = 60 * 1000; // 1 minute
export async function checkScanRateLimit(identifier: string): Promise<CheckResult> {
	const limiter = getScanRateLimiter();
	try {
		const result = await Promise.race([
			limiter.limit(identifier),
			timeout(SCAN_RATE_LIMIT_TIMEOUT_MS)
		]) as { success?: boolean };

		const allowed = Boolean(result && result.success);
		return { allowed, fallback: false };
	} catch (err) {
		// Upstash failed; decide fallback behavior
		if (AUTH_RATE_LIMIT_FAIL_CLOSED) {
				const reason = 'upstash_unavailable_fail_closed';
				createServerLogger('lib.rate-limit').warn('Upstash unavailable; fail-closed active for scan rate limit');
			return { allowed: false, fallback: true, reason };
		}

		const allowed = scanLocalLimiter.allow(identifier);
				const reason = 'upstash_unavailable_local_fallback';
				void err;
				createServerLogger('lib.rate-limit').warn('Upstash unavailable; using local scan limiter fallback');
		return { allowed, fallback: true, reason };
	}
}

// --- Auth-specific rate limiters ---
const AUTH_LOGIN_RATE_LIMIT_PREFIX = 'isfake:auth-login-ip';
const AUTH_LOGIN_RATE_LIMIT_WINDOW = '15 m';
const AUTH_LOGIN_RATE_LIMIT_MAX = 5;

const AUTH_SIGNUP_RATE_LIMIT_PREFIX = 'isfake:auth-signup-ip';
const AUTH_SIGNUP_RATE_LIMIT_WINDOW = '1 h';
const AUTH_SIGNUP_RATE_LIMIT_MAX = 10;

const scanLocalLimiter = new EmergencyLocalLimiter(SCAN_RATE_LIMIT_MAX, LOCAL_WINDOW_MS);
const authLoginLocalLimiter = new EmergencyLocalLimiter(AUTH_LOGIN_RATE_LIMIT_MAX, LOCAL_WINDOW_MS);
const authSignupLocalLimiter = new EmergencyLocalLimiter(AUTH_SIGNUP_RATE_LIMIT_MAX, LOCAL_WINDOW_MS);

let authLoginRateLimiter: Ratelimit | null = null;
let authSignupRateLimiter: Ratelimit | null = null;

function getAuthLoginRateLimiter() {
	if (!authLoginRateLimiter) {
		authLoginRateLimiter = new Ratelimit({
			redis: Redis.fromEnv(),
			limiter: Ratelimit.slidingWindow(AUTH_LOGIN_RATE_LIMIT_MAX, AUTH_LOGIN_RATE_LIMIT_WINDOW),
			analytics: true,
			prefix: AUTH_LOGIN_RATE_LIMIT_PREFIX
		});
	}
	return authLoginRateLimiter;
}

function getAuthSignupRateLimiter() {
	if (!authSignupRateLimiter) {
		authSignupRateLimiter = new Ratelimit({
			redis: Redis.fromEnv(),
			limiter: Ratelimit.slidingWindow(AUTH_SIGNUP_RATE_LIMIT_MAX, AUTH_SIGNUP_RATE_LIMIT_WINDOW),
			analytics: true,
			prefix: AUTH_SIGNUP_RATE_LIMIT_PREFIX
		});
	}
	return authSignupRateLimiter;
}

export async function checkAuthLoginRateLimit(identifier: string): Promise<CheckResult> {
	const limiter = getAuthLoginRateLimiter();
	try {
		const result = await Promise.race([
			limiter.limit(identifier),
			timeout(SCAN_RATE_LIMIT_TIMEOUT_MS)
		]) as { success?: boolean };

		const allowed = Boolean(result && result.success);
		return { allowed, fallback: false };
	} catch (err) {
		if (AUTH_RATE_LIMIT_FAIL_CLOSED) {
			const reason = 'upstash_unavailable_fail_closed';
			createServerLogger('lib.rate-limit').warn('Upstash unavailable; fail-closed active for auth login rate limit');
			return { allowed: false, fallback: true, reason };
		}

		const allowed = authLoginLocalLimiter.allow(identifier);
				const reason = 'upstash_unavailable_local_fallback';
				void err;
				createServerLogger('lib.rate-limit').warn('Upstash unavailable; using local auth-login limiter fallback');
		return { allowed, fallback: true, reason };
	}
}

export async function checkAuthSignupRateLimit(identifier: string): Promise<CheckResult> {
	const limiter = getAuthSignupRateLimiter();
	try {
		const result = await Promise.race([
			limiter.limit(identifier),
			timeout(SCAN_RATE_LIMIT_TIMEOUT_MS)
		]) as { success?: boolean };

		const allowed = Boolean(result && result.success);
		return { allowed, fallback: false };
	} catch (err) {
		if (AUTH_RATE_LIMIT_FAIL_CLOSED) {
			const reason = 'upstash_unavailable_fail_closed';
			createServerLogger('lib.rate-limit').warn('Upstash unavailable; fail-closed active for auth signup rate limit');
			return { allowed: false, fallback: true, reason };
		}

		const allowed = authSignupLocalLimiter.allow(identifier);
				const reason = 'upstash_unavailable_local_fallback';
				void err;
				createServerLogger('lib.rate-limit').warn('Upstash unavailable; using local auth-signup limiter fallback');
		return { allowed, fallback: true, reason };
	}
}

// --- Account lock helpers (per-email) ---
const AUTH_LOCK_PREFIX = 'isfake:auth-lock:';
const AUTH_LOCK_TTL_SECONDS = 60 * 60; // 1 hour
const AUTH_LOCK_MAX_ATTEMPTS = 10;

type LockResult = { locked: boolean; attempts: number; ttl?: number; fallback?: boolean };

const localFailedLogins = new Map<string, { count: number; first: number }>();

export async function recordFailedLogin(identifier: string): Promise<LockResult> {

	const key = `${AUTH_LOCK_PREFIX}${identifier}`;
	try {
		const redis = Redis.fromEnv();
		const attemptsRaw = await redis.incr(key);
		const attempts = Number(attemptsRaw ?? 0);
		if (attempts === 1) {
			await redis.expire(key, AUTH_LOCK_TTL_SECONDS);
		}
		const ttl = Number(await redis.ttl(key));
		const locked = attempts >= AUTH_LOCK_MAX_ATTEMPTS;
		return { locked, attempts, ttl, fallback: false };
	} catch {
		// Fallback to local in-memory counter with TTL
		const now = Date.now();
		const rec = localFailedLogins.get(identifier) || { count: 0, first: now };
		if (now - rec.first > AUTH_LOCK_TTL_SECONDS * 1000) {
			rec.count = 0;
			rec.first = now;
		}
		rec.count += 1;
		localFailedLogins.set(identifier, rec);
		const locked = rec.count >= AUTH_LOCK_MAX_ATTEMPTS;
		const ttl = locked ? Math.max(0, AUTH_LOCK_TTL_SECONDS - Math.floor((now - rec.first) / 1000)) : undefined;
		return { locked, attempts: rec.count, ttl, fallback: true };
	}
}

export async function resetFailedLogin(identifier: string): Promise<void> {
	const key = `${AUTH_LOCK_PREFIX}${identifier}`;
	try {
		const redis = Redis.fromEnv();
		await redis.del(key);
	} catch {
		localFailedLogins.delete(identifier);
	}
}

export async function isAccountLocked(identifier: string): Promise<LockResult> {
	const key = `${AUTH_LOCK_PREFIX}${identifier}`;
	try {
		const redis = Redis.fromEnv();
		const val = await redis.get(key);
		const attempts = val ? Number(val) : 0;
		const locked = attempts >= AUTH_LOCK_MAX_ATTEMPTS;
		const ttl = locked ? Number(await redis.ttl(key)) : undefined;
		return { locked, attempts, ttl, fallback: false };
	} catch {
		const rec = localFailedLogins.get(identifier);
		const attempts = rec?.count || 0;
		const locked = attempts >= AUTH_LOCK_MAX_ATTEMPTS;
		const ttl = rec ? Math.max(0, AUTH_LOCK_TTL_SECONDS - Math.floor((Date.now() - rec.first) / 1000)) : undefined;
		return { locked, attempts, ttl, fallback: true };
	}
}
