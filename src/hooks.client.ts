export const init = () => {};

export const handleError = ({ error, event }: { error: unknown; event: unknown }) => {
	// Server-side error tracking via @sentry/node in hooks.server.ts
	// Client errors will be captured there via instrumentation
	console.error('Client error:', error);
};