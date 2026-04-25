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
				wrap: 'border-slate-700 bg-slate-900',
				bar: 'bg-sky-400',
				pill: 'border-sky-300/30 text-sky-100',
				label: 'Flagged',
				text: 'text-sky-100'
			};
		}

		return {
			wrap: 'border-slate-700 bg-slate-900',
			bar: 'bg-sky-400',
			pill: 'border-sky-300/30 text-sky-100',
			label: 'Clear',
			text: 'text-sky-100'
		};
	}

	function getNestedIdentity(result: VerificationResult) {
		return result.product_identity ?? {
			verified_name: result.product_name ?? result.brand,
			brand: result.brand,
			verified_brand: result.verified_brand ?? result.brand,
			category: 'Unknown',
			confidence_score: result.confidence_score ?? 0
		};
	}

	function getNestedOrigin(result: VerificationResult) {
		return result.origin_details ?? {
			physical_origin_country: result.origin_country,
			legal_registration_prefix: 'UNKNOWN'
		};
	}

	function getNestedCorp(result: VerificationResult) {
		return result.corporate_structure ?? {
			ultimate_parent_company: result.parent_company,
			global_hq_country: result.holding_company_hq ?? 'UNKNOWN'
		};
	}

	function getNestedCompliance(result: VerificationResult) {
		return result.compliance ?? {
			is_flagged: result.is_flagged,
			flag_reason: result.flag_reason ?? null
		};
	}
</script>

{#if result}
	{@const tone = getTone(result)}
	{@const identity = getNestedIdentity(result)}
	{@const origin = getNestedOrigin(result)}
	{@const corp = getNestedCorp(result)}
	{@const compliance = getNestedCompliance(result)}
	<article class={`overflow-hidden rounded-2xl border ${tone.wrap} anim-in`}>
		<div class={`h-1 w-full ${tone.bar} anim-line-soft`}></div>

		<div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 px-4 py-3">
			<span class={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${tone.pill}`}>
				{tone.label}
			</span>
			<span class="rounded-full border border-slate-600 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300">
				V6 forensic audit
			</span>
		</div>

		<div class="space-y-4 px-4 py-4">
			<div class="space-y-1">
				<p class="text-[11px] uppercase tracking-[0.18em] text-slate-400">Verified name</p>
				<h2 class="wrap-break-word font-[Fraunces,serif] text-3xl leading-[1.04] text-white">{identity.verified_name}</h2>
				<p class="text-sm text-slate-200">{identity.brand}</p>
				<p class="break-all font-mono text-[11px] text-slate-400">{result.barcode}</p>
			</div>

			<div class="grid gap-2 sm:grid-cols-2">
				<div class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-slate-400">Category</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{identity.category}</p>
				</div>
				<div class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-slate-400">Confidence</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{Math.round((identity.confidence_score ?? result.confidence_score ?? 0) * 100)}%</p>
				</div>
				<div class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-slate-400">Physical origin</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{origin.physical_origin_country}</p>
				</div>
				<div class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-slate-400">Legal prefix</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{origin.legal_registration_prefix}</p>
				</div>
			</div>

			<div class="grid gap-2">
				<div class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-slate-400">Ultimate parent</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{corp.ultimate_parent_company}</p>
				</div>
				<div class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-slate-400">Parent HQ country</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{corp.global_hq_country}</p>
				</div>
			</div>

			<div class="grid gap-2">
				<div class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-slate-400">Compliance</p>
					<p class={`mt-1 text-sm ${compliance.is_flagged ? 'text-sky-100' : 'text-slate-200'}`}>
						{compliance.is_flagged ? 'Flagged' : 'Clear'}
					</p>
					{#if compliance.flag_reason}
						<p class="mt-1 text-sm leading-relaxed text-slate-300">{compliance.flag_reason}</p>
					{/if}
				</div>
				<div class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-slate-400">Arbitration log</p>
					<p class="mt-1 text-sm leading-relaxed text-slate-300">{result.arbitration_log ?? result.reasoning}</p>
				</div>
			</div>
		</div>
	</article>
{/if}