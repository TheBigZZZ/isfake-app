import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getHealthSnapshot } from '$lib/server/health';

export const GET: RequestHandler = async () => {
	const snapshot = getHealthSnapshot();
	const health = {
		status: 'ok',
		timestamp: new Date().toISOString(),
		db_connected: snapshot.db_connected,
		upstash_connected: snapshot.upstash_connected
	};

	const allHealthy = snapshot.db_connected && snapshot.upstash_connected;
	const statusCode = allHealthy ? 200 : 503;

	return json(health, { status: statusCode });
};
