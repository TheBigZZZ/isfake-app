<script lang="ts">
	import type { VerificationResult } from '$lib/verification';

	let {
		result,
	} = $props<{
		result: VerificationResult | null;
	}>();

	function getTone(value: VerificationResult) {
		if (value.is_flagged) {
			return {
				wrap: 'border-amber-400/70 bg-amber-950/80',
				bar: 'bg-amber-400',
				pill: 'border-amber-300 bg-amber-950 text-amber-200',
				label: 'Flagged',
				text: 'text-amber-100'
			};
		}

		return {
			wrap: 'border-emerald-400/70 bg-emerald-950/80',
			bar: 'bg-emerald-400',
			pill: 'border-emerald-300 bg-emerald-950 text-emerald-200',
			label: 'Clear',
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
		</div>

		<div class="space-y-4 px-4 py-4">
			<div class="space-y-1">
				<p class="text-[11px] uppercase tracking-[0.18em] text-white/50">Brand</p>
				<h2 class="wrap-break-word font-[Fraunces,serif] text-3xl leading-[1.04] text-white">{result.brand}</h2>
				<p class="break-all font-mono text-[11px] text-white/55">{result.barcode}</p>
			</div>

			<div class="grid gap-2 sm:grid-cols-2">
				<div class="rounded-2xl border border-white/10 bg-black/20 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-white/45">Parent company</p>
					<p class="mt-1 break-words text-sm text-white">{result.parent_company}</p>
				</div>
				<div class="rounded-2xl border border-white/10 bg-black/20 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-white/45">Origin country</p>
					<p class="mt-1 break-words text-sm text-white">{result.origin_country}</p>
				</div>
			</div>

			<p class={`rounded-2xl border border-white/10 px-3 py-3 text-sm leading-relaxed ${tone.text}`}>
				{result.reasoning}
			</p>
		</div>
	</article>
{/if}