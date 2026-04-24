<script lang="ts">
	import type { VerificationResult, VoteAction } from '$lib/verification';

	let {
		result,
		voting = false,
		onVote
	} = $props<{
		result: VerificationResult | null;
		voting?: boolean;
		onVote: (action: VoteAction, result: VerificationResult) => void | Promise<void>;
	}>();

	const confidenceThreshold = 0.55;

	function getTone(value: VerificationResult) {
		if (value.status === 'review' || value.confidence < confidenceThreshold) {
			return {
				wrap: 'border-amber-400/70 bg-amber-950/80',
				bar: 'bg-amber-400',
				pill: 'border-amber-300 bg-amber-950 text-amber-200',
				label: 'Needs review',
				text: 'text-amber-100'
			};
		}

		if (value.is_israeli) {
			return {
				wrap: 'border-rose-400/70 bg-rose-950/80',
				bar: 'bg-rose-500',
				pill: 'border-rose-300 bg-rose-950 text-rose-200',
				label: 'Israeli-owned',
				text: 'text-rose-100'
			};
		}

		return {
			wrap: 'border-emerald-400/70 bg-emerald-950/80',
			bar: 'bg-emerald-400',
			pill: 'border-emerald-300 bg-emerald-950 text-emerald-200',
			label: 'Not Israeli-owned',
			text: 'text-emerald-100'
		};
	}
</script>

{#if result}
	{@const tone = getTone(result)}
	<article class={`overflow-hidden rounded-3xl border shadow-[0_22px_50px_rgba(0,0,0,0.36)] backdrop-blur ${tone.wrap}`}>
		<div class={`h-1 w-full ${tone.bar}`}></div>

		<div class="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
			<span class={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${tone.pill}`}>
				{tone.label}
			</span>
			<span class="max-w-full break-all text-[11px] uppercase tracking-[0.18em] text-white/50">
				{result.source} · confidence {(result.confidence * 100).toFixed(0)}%
			</span>
		</div>

		<div class="space-y-4 px-4 py-4">
			<div class="space-y-1">
				<p class="text-[11px] uppercase tracking-[0.18em] text-white/50">Barcode</p>
				<h2 class="wrap-break-word font-[Fraunces,serif] text-3xl leading-[1.04] text-white">
					{result.name}
				</h2>
				{#if result.brand}
					<p class="wrap-break-word text-xs uppercase tracking-[0.18em] text-amber-200/90">{result.brand}</p>
				{/if}
				<p class="break-all font-mono text-[11px] text-white/55">{result.barcode}</p>
			</div>

			<p class={`rounded-2xl border border-white/10 px-3 py-3 text-sm leading-relaxed ${tone.text}`}>
				{result.reasoning}
			</p>

			{#if result.context_text}
				<div class="rounded-2xl border border-white/10 bg-black/20 px-3 py-2.5 text-xs leading-relaxed text-white/70">
					<p class="mb-1 text-[10px] uppercase tracking-[0.18em] text-white/45">Google context</p>
					<p class="wrap-break-word">{result.context_text}</p>
				</div>
			{/if}

			<div class="grid grid-cols-3 gap-2">
				<div class="min-w-0 rounded-2xl border border-white/10 bg-black/20 p-2 text-center">
					<p class="truncate text-[10px] uppercase tracking-[0.12em] text-white/45">Votes</p>
					<p class="font-[Fraunces,serif] text-[1.25rem] leading-none text-white">{result.vote_count ?? 0}</p>
				</div>
				<div class="min-w-0 rounded-2xl border border-white/10 bg-black/20 p-2 text-center">
					<p class="truncate text-[10px] uppercase tracking-[0.12em] text-white/45">Verify</p>
					<p class="font-[Fraunces,serif] text-[1.25rem] leading-none text-white">{result.verify_votes ?? 0}</p>
				</div>
				<div class="min-w-0 rounded-2xl border border-white/10 bg-black/20 p-2 text-center">
					<p class="truncate text-[10px] uppercase tracking-[0.12em] text-white/45">Correct</p>
					<p class="font-[Fraunces,serif] text-[1.25rem] leading-none text-white">{result.correct_votes ?? 0}</p>
				</div>
			</div>

			{#if result.status !== 'verified'}
				<div class="grid gap-2 sm:grid-cols-2">
					<button
						class="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-950 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
						onclick={() => onVote('verify', result)}
						disabled={voting}
					>
						Verify
					</button>
					<button
						class="rounded-2xl border border-white/20 bg-transparent px-4 py-3 text-sm font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
						onclick={() => onVote('correct', result)}
						disabled={voting}
					>
						Correct
					</button>
				</div>
			{:else}
				<div class="rounded-2xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white/75">
					Consensus locked after community verification.
				</div>
			{/if}
		</div>
	</article>
{/if}