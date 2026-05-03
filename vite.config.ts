
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	ssr: {
		external: [
			'@opentelemetry/resources',
			'@sentry/sveltekit',
			'@sentry/node',
			'@opentelemetry/sdk-trace-base',
			'@opentelemetry/instrumentation',
			'@opentelemetry/core',
			'@opentelemetry/instrumentation-http'
		]
	},
	build: {
		rollupOptions: {
			external: id => /@opentelemetry/.test(id) || /opentelemetry/.test(id) || /@sentry\//.test(id)
		}
	}
});
