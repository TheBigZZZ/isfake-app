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
				wrap: 'border-sky-300/20 bg-slate-950/80',
				bar: 'bg-linear-to-r from-sky-400 via-cyan-300 to-sky-500 bg-size-[200%_200%] shadow-[0_0_24px_rgba(56,189,248,0.22)]',
				pill: 'border-sky-300/25 bg-sky-400/10 text-sky-100',
				label: 'Flagged',
				text: 'text-sky-100'
			};
		}

		return {
			wrap: 'border-sky-300/20 bg-slate-950/80',
			bar: 'bg-linear-to-r from-sky-400 via-cyan-300 to-sky-500 bg-size-[200%_200%] shadow-[0_0_24px_rgba(56,189,248,0.22)]',
			pill: 'border-sky-300/25 bg-sky-400/10 text-sky-100',
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
	<article class={`overflow-hidden rounded-[1.75rem] border shadow-[0_24px_60px_rgba(3,10,22,0.55)] backdrop-blur-xl ${tone.wrap}`}>
		<div class={`h-1.5 w-full ${tone.bar} animate-shimmer`}></div>

		<div class="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
			<span class={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${tone.pill}`}>
				{tone.label}
			</span>
			<span class="rounded-full border border-sky-300/15 bg-white/5 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-sky-100/70">
				V5 forensic audit
			</span>
		</div>

		<div class="space-y-4 px-4 py-4">
			<div class="space-y-1 animate-fade-up">
				<p class="text-[11px] uppercase tracking-[0.18em] text-sky-100/50">Verified name</p>
				<h2 class="wrap-break-word font-[Fraunces,serif] text-3xl leading-[1.04] text-white">{identity.verified_name}</h2>
				<p class="text-sm text-sky-100/75">{identity.brand}</p>
				<p class="break-all font-mono text-[11px] text-white/55">{result.barcode}</p>
			</div>

			<div class="grid gap-2 sm:grid-cols-2 animate-fade-up-1">
				<div class="rounded-2xl border border-sky-300/15 bg-sky-400/5 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-sky-100/45">Category</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{identity.category}</p>
				</div>
				<div class="rounded-2xl border border-sky-300/15 bg-sky-400/5 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-sky-100/45">Confidence</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{Math.round((identity.confidence_score ?? result.confidence_score ?? 0) * 100)}%</p>
				</div>
				<div class="rounded-2xl border border-sky-300/15 bg-black/20 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-sky-100/45">Physical origin</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{origin.physical_origin_country}</p>
				</div>
				<div class="rounded-2xl border border-sky-300/15 bg-black/20 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-sky-100/45">Legal prefix</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{origin.legal_registration_prefix}</p>
				</div>
			</div>

			<div class="grid gap-2 animate-fade-up-2">
				<div class="rounded-2xl border border-sky-300/15 bg-slate-900/60 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-sky-100/45">Ultimate parent</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{corp.ultimate_parent_company}</p>
				</div>
				<div class="rounded-2xl border border-sky-300/15 bg-slate-900/60 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-sky-100/45">Parent HQ country</p>
					<p class="mt-1 wrap-break-word text-sm text-white">{corp.global_hq_country}</p>
				</div>
			</div>

			<div class="grid gap-2 animate-fade-up-3">
				<div class="rounded-2xl border border-sky-300/15 bg-white/5 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-sky-100/45">Compliance</p>
					<p class={`mt-1 text-sm ${compliance.is_flagged ? 'text-sky-100' : 'text-slate-200'}`}>
						{compliance.is_flagged ? 'Flagged' : 'Clear'}
					</p>
					{#if compliance.flag_reason}
						<p class="mt-1 text-sm leading-relaxed text-slate-300">{compliance.flag_reason}</p>
					{/if}
				</div>
				<div class="rounded-2xl border border-sky-300/15 bg-white/5 px-3 py-2.5">
					<p class="text-[10px] uppercase tracking-[0.18em] text-sky-100/45">Arbitration log</p>
					<p class="mt-1 text-sm leading-relaxed text-slate-300">{result.arbitration_log ?? result.reasoning}</p>
				</div>
			</div>
		</div>
	</article>
{/if}