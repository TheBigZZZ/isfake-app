import { Redis } from '@upstash/redis';
import { getAdminSupabase } from '$lib/server/supabase';

type HealthSnapshot = {
	timestamp: string;
	db_connected: boolean;
	upstash_connected: boolean;
};

const HEALTH_REFRESH_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_000;

let cachedHealth: HealthSnapshot = {
	timestamp: new Date(0).toISOString(),
	db_connected: false,
	upstash_connected: false
};

let lastRefreshAt = 0;
let refreshInFlight: Promise<void> | null = null;

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	return Promise.race([
		promise.then((value) => value).catch(() => null),
		new Promise<null>((resolve) => {
			timeoutId = setTimeout(() => resolve(null), timeoutMs);
		})
	]).finally(() => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	});
}

async function probeDatabase(): Promise<boolean> {
	try {
		const client = getAdminSupabase();
		const query = client.from('scan_history').select('count()', {
			count: 'exact',
			head: true
		});
		const result = await raceWithTimeout(query as unknown as Promise<{ error?: unknown }>, PROBE_TIMEOUT_MS);
		return !result?.error;
	} catch {
		return false;
	}
}

async function probeUpstash(): Promise<boolean> {
	try {
		const redis = Redis.fromEnv();
		const result = await raceWithTimeout(redis.ping(), PROBE_TIMEOUT_MS);
		return result === 'PONG';
	} catch {
		return false;
	}
}

async function refreshHealthSnapshot() {
	if (refreshInFlight) return refreshInFlight;

	refreshInFlight = (async () => {
		const [dbConnected, upstashConnected] = await Promise.all([probeDatabase(), probeUpstash()]);
		cachedHealth = {
			timestamp: new Date().toISOString(),
			db_connected: dbConnected,
			upstash_connected: upstashConnected
		};
		lastRefreshAt = Date.now();
	})().finally(() => {
		refreshInFlight = null;
	});

	return refreshInFlight;
}

export function getHealthSnapshot(): HealthSnapshot {
	if (Date.now() - lastRefreshAt >= HEALTH_REFRESH_INTERVAL_MS) {
		void refreshHealthSnapshot();
	}

	return cachedHealth;
}

void refreshHealthSnapshot();