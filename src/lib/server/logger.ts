type LogLevel = 'info' | 'warn' | 'error';

type LogContext = {
	requestId?: string;
	route?: string;
	status?: number;
	durationMs?: number;
	details?: Record<string, unknown>;
	error?: unknown;
};

const SENSITIVE_KEY_PATTERN =
	/(authorization|cookie|set-cookie|token|secret|password|api[-_]?key)/i;
const MAX_LOG_STRING_LENGTH = 240;

import * as Sentry from '@sentry/node';

const sentryEnabled = Boolean(process.env.SENTRY_DSN);

export function createServerLogger(route: string, requestId?: string) {
	return {
		info(message: string, context: Omit<LogContext, 'error'> = {}) {
			writeLog('info', route, requestId, message, context);
		},
		warn(message: string, context: Omit<LogContext, 'error'> = {}) {
			writeLog('warn', route, requestId, message, context);
		},
		error(message: string, error: unknown, context: Omit<LogContext, 'error'> = {}) {
			writeLog('error', route, requestId, message, { ...context, error });
		}
	};
}

function writeLog(
	level: LogLevel,
	route: string,
	requestId: string | undefined,
	message: string,
	context: LogContext
) {
	const entry = {
		level,
		timestamp: new Date().toISOString(),
		route,
		requestId,
		message,
		...sanitizeContext(context)
	};

	if (level === 'error') {
		console.error(JSON.stringify(entry));
		if (sentryEnabled && context.error) {
			try {
				Sentry.captureException(context.error);
			} catch {
				/* noop */
			}
		}
		return;
	}

	if (level === 'warn') {
		console.warn(JSON.stringify(entry));
		return;
	}

	console.log(JSON.stringify(entry));
}

function sanitizeContext(context: LogContext) {
	const output: Record<string, unknown> = {};

	if (context.requestId) output.requestId = context.requestId;
	if (context.status !== undefined) output.status = context.status;
	if (context.durationMs !== undefined) output.durationMs = context.durationMs;
	if (context.details !== undefined) output.details = sanitizeUnknown(context.details);
	if (context.error !== undefined) {
		output.error =
			context.error instanceof Error
				? {
						name: context.error.name,
						message: context.error.message
					}
				: typeof context.error === 'string'
					? context.error
					: 'unknown_error';
	}

	return output;
}

function sanitizeUnknown(value: unknown): unknown {
	if (typeof value === 'string') {
		return value.length > MAX_LOG_STRING_LENGTH
			? `${value.slice(0, MAX_LOG_STRING_LENGTH)}...[truncated]`
			: value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => sanitizeUnknown(item));
	}

	if (value && typeof value === 'object') {
		const safe: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (SENSITIVE_KEY_PATTERN.test(key)) {
				safe[key] = '[Filtered]';
				continue;
			}
			safe[key] = sanitizeUnknown(item);
		}
		return safe;
	}

	return value;
}
