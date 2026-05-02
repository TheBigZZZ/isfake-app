<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { supabase } from '$lib/supabase';

	let status = $state('Completing Google sign-in...');
	let errorMessage = $state<string | null>(null);

	onMount(async () => {
		const url = new URL(window.location.href);
		const code = url.searchParams.get('code');
		const error = url.searchParams.get('error_description') || url.searchParams.get('error');

		if (error) {
			errorMessage = error;
			status = 'Google sign-in failed.';
			return;
		}

		if (!code) {
			status = 'No OAuth code was returned. Redirecting home...';
			await goto('/', { replaceState: true });
			return;
		}

		try {
			const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
			if (exchangeError) {
				errorMessage = exchangeError.message;
				status = 'Could not complete Google sign-in.';
				return;
			}

			status = 'Signed in. Redirecting...';
			await goto('/', { replaceState: true });
		} catch (caughtError) {
			errorMessage = caughtError instanceof Error ? caughtError.message : 'Could not complete Google sign-in.';
			status = 'Google sign-in failed.';
		}
	});
</script>

<svelte:head>
	<title>Completing sign-in - IsFake</title>
</svelte:head>

<main class="flex min-h-dvh items-center justify-center bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.14),transparent_40%),linear-gradient(180deg,#020617_0%,#0f172a_58%,#020617_100%)] px-4 text-slate-100">
	<div class="w-full max-w-md rounded-[1.75rem] border border-sky-300/15 bg-slate-950/80 p-6 shadow-[0_24px_80px_rgba(2,6,23,0.45)] backdrop-blur">
		<p class="text-[11px] uppercase tracking-[0.24em] text-sky-200/65">Google OAuth</p>
		<h1 class="mt-2 font-[Fraunces,serif] text-3xl leading-tight text-white">{status}</h1>
		{#if errorMessage}
			<p class="mt-4 text-sm leading-relaxed text-rose-200">{errorMessage}</p>
		{/if}
	</div>
</main>
