import { env } from '$env/dynamic/private';

const REQUIRED_SERVER_SECRETS = [
	'SUPABASE_URL',
	'SUPABASE_SERVICE_ROLE_KEY',
	'OPENROUTER_API_KEY',
	'SEARCH_API_KEY',
	'UPSTASH_REDIS_REST_URL',
	'UPSTASH_REDIS_REST_TOKEN'
] as const;

const OPTIONAL_SERVER_SECRETS = ['OPENCORPORATES_API_TOKEN', 'SENTRY_DSN'] as const;

let validated = false;

export function validateServerEnv() {
	if (validated) return;

	const missingRequired = REQUIRED_SERVER_SECRETS.filter((key) => !normalizeValue(env[key]));
	if (missingRequired.length > 0) {
		throw new Error(`Missing required server environment variables: ${missingRequired.join(', ')}`);
	}

	for (const key of OPTIONAL_SERVER_SECRETS) {
		if (env[key] && !normalizeValue(env[key])) {
			throw new Error(`Server environment variable ${key} is set but empty.`);
		}
	}

	validated = true;
}

export function getRequestId(request: Request): string {
	return normalizeValue(request.headers.get('x-request-id')) || crypto.randomUUID();
}

function normalizeValue(value: string | undefined | null): string {
	return value?.trim() || '';
}