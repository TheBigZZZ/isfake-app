<script lang="ts">
	const throwFrontendError = () => {
		console.warn('Sentry example client warning', { source: 'sentry-example-page', action: 'throw_frontend_error' });
		throw new Error('Sentry example frontend error');
	};

	const triggerServerTrace = async () => {
		console.info('Sentry example client info log', { source: 'sentry-example-page', action: 'trigger_server_trace' });
		await fetch('/api/health');
	};
</script>

<svelte:head>
	<title>Sentry Example</title>
</svelte:head>

<main class="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 px-6 py-10 text-slate-100">
	<section class="rounded-3xl border border-slate-700 bg-slate-950/80 p-6 shadow-xl">
		<p class="text-xs uppercase tracking-[0.24em] text-sky-200/70">Sentry verification</p>
		<h1 class="mt-2 text-3xl font-semibold text-white">Test Sentry capture</h1>
		<p class="mt-3 text-sm leading-6 text-slate-300">
			Use this page to trigger a frontend exception and a server request that should create a trace.
		</p>

		<div class="mt-6 flex flex-col gap-3 sm:flex-row">
			<button class="rounded-xl bg-sky-300 px-4 py-3 font-semibold text-slate-950" onclick={throwFrontendError}>
				Throw frontend error
			</button>
			<button class="rounded-xl border border-sky-300/30 px-4 py-3 font-semibold text-slate-100" onclick={triggerServerTrace}>
				Trigger server trace
			</button>
		</div>
	</section>
</main>