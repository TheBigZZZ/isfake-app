<script lang="ts">
  import { onMount } from "svelte";
  import { CapacitorBarcodeScanner } from "@capacitor/barcode-scanner";
  import { App } from "@capacitor/app";
  import VerificationCard from "$lib/components/VerificationCard.svelte";
  import { verifyBarcode } from "$lib/supabase";
  import type { VerificationResult } from "$lib/verification";

  let isScanning = $state(false);
  let manualInput = $state("");
  let evaluation = $state<VerificationResult | null>(null);
  let currentAction = $state<"idle" | "scanning" | "checking">("idle");
  let errorMessage = $state<string | null>(null);

  onMount(() => {
    const backBtnListener = App.addListener("backButton", () => {
      if (isScanning) {
        isScanning = false;
        currentAction = "idle";
      } else if (evaluation !== null) {
        evaluation = null;
      } else {
        App.exitApp();
      }
    });
    return () => { backBtnListener.then(l => l.remove()); };
  });

  const triggerVerification = async (barcode: string) => {
    if (!barcode) return;
    currentAction = "checking";
    errorMessage = null;
    evaluation = null;
    try {
      evaluation = await verifyBarcode(barcode);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Verification failed.";
      evaluation = null;
    } finally {
      currentAction = "idle";
    }
  };

  const startScan = async () => {
    isScanning = true;
    currentAction = "scanning";
    evaluation = null;

    try {
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: 17,
        cameraDirection: 1
      });

      if (result && result.ScanResult) {
        await triggerVerification(result.ScanResult);
      }
    } catch (e) {
      console.error("Scan aborted or failed", e);
    } finally {
      isScanning = false;
      if (currentAction === "scanning") currentAction = "idle";
    }
  };

  const handleManualSubmit = (e: Event) => {
    e.preventDefault();
    if (manualInput.trim()) {
      triggerVerification(manualInput.trim());
    }
  };

  const reset = () => {
    evaluation = null;
    manualInput = "";
    currentAction = "idle";
    errorMessage = null;
  };
</script>

<main class="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
  <div class="pointer-events-none absolute inset-0 opacity-60 animate-float-slow [background:radial-gradient(70%_45%_at_18%_12%,rgba(56,189,248,0.20),transparent_60%),radial-gradient(60%_40%_at_85%_10%,rgba(96,165,250,0.14),transparent_55%)]"></div>
  <div class="pointer-events-none absolute inset-x-0 top-0 h-28 bg-linear-to-b from-sky-300/10 to-transparent"></div>

  <header class="relative z-10 shrink-0 px-4 pb-4 pt-5 animate-fade-up">
    <div class="mx-auto w-full max-w-md space-y-4">
      <div class="flex items-center justify-between gap-3">
        <div class="space-y-1">
          <p class="text-[10px] font-semibold uppercase tracking-[0.34em] text-sky-200/70">Corporate audit scanner</p>
          <h1 class="font-[Fraunces,serif] text-3xl leading-none text-white">IsFake</h1>
        </div>
        <span class="rounded-full border border-sky-300/30 bg-sky-400/10 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-sky-100/80 shadow-[0_0_24px_rgba(56,189,248,0.10)]">
          live
        </span>
      </div>

      <div class="relative overflow-hidden rounded-[1.75rem] border border-sky-300/15 bg-slate-950/70 px-4 py-4 shadow-[0_24px_60px_rgba(3,10,22,0.55)] backdrop-blur-xl animate-fade-up-1">
        <div class="pointer-events-none absolute inset-0 bg-linear-to-br from-sky-400/10 via-transparent to-cyan-300/5"></div>
        <div class="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-sky-300/15 blur-2xl animate-float-slow"></div>
        <div class="relative space-y-4">
          <div class="inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-white/5 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-sky-100/70">
            <span class="h-1.5 w-1.5 rounded-full bg-sky-300 shadow-[0_0_16px_rgba(125,211,252,0.95)]"></span>
            Arbitration-grade brand tracing
          </div>

          <div class="space-y-2">
            <h2 class="max-w-[14ch] font-[Fraunces,serif] text-[2.25rem] leading-[0.94] tracking-[-0.03em] text-white">
              Scan the barcode. Reveal the chain behind it.
            </h2>
            <p class="max-w-[34ch] text-sm leading-6 text-slate-300">
              Premium corporate auditing for brand identity, physical origin, and ultimate parent mapping with conflict resolution.
            </p>
          </div>

          <div class="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-[0.16em] text-sky-100/55">
            <div class="rounded-2xl border border-sky-300/15 bg-black/20 px-2.5 py-2 text-center">Brand</div>
            <div class="rounded-2xl border border-sky-300/15 bg-black/20 px-2.5 py-2 text-center">Origin</div>
            <div class="rounded-2xl border border-sky-300/15 bg-black/20 px-2.5 py-2 text-center">Parent</div>
          </div>

          <div class="h-px w-full bg-linear-to-r from-transparent via-sky-300/35 to-transparent animate-shimmer"></div>
        </div>
      </div>
    </div>
  </header>

  <section class="relative z-10 min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
    <div class="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-6 pt-1">
      <div class:hidden={isScanning} class="rounded-[1.75rem] border border-sky-300/15 bg-slate-950/70 p-4 shadow-[0_24px_60px_rgba(3,10,22,0.55)] backdrop-blur-xl animate-fade-up-2">
        <button
          class="w-full rounded-2xl border border-sky-300/25 bg-linear-to-r from-sky-500 via-cyan-400 to-sky-300 bg-size-[200%_200%] px-4 py-3.5 text-sm font-semibold text-slate-950 shadow-[0_16px_36px_rgba(56,189,248,0.25)] transition duration-300 ease-out hover:-translate-y-px hover:shadow-[0_20px_44px_rgba(56,189,248,0.32)] hover:bg-position-[100%_50%] active:scale-[0.99] disabled:cursor-not-allowed disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500"
          onclick={startScan}
          disabled={currentAction !== "idle"}
        >
          {currentAction === "scanning" ? "Scanning..." : "Scan Product Barcode"}
        </button>

        <div class="my-4 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-sky-100/40">
          <span class="h-px flex-1 bg-linear-to-r from-transparent via-sky-200/25 to-transparent"></span>
          <span>or enter manually</span>
          <span class="h-px flex-1 bg-linear-to-r from-transparent via-sky-200/25 to-transparent"></span>
        </div>

        <form class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onsubmit={handleManualSubmit}>
          <input
            type="text"
            inputmode="numeric"
            bind:value={manualInput}
            placeholder="Barcode number"
            class="min-w-0 w-full rounded-2xl border border-sky-300/15 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 outline-none transition focus:border-sky-300/50 focus:ring-2 focus:ring-sky-300/20 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={currentAction !== "idle"}
          />
          <button
            type="submit"
            class="w-full shrink-0 rounded-2xl border border-sky-300/20 bg-sky-400/10 px-4 py-2.5 text-sm font-semibold text-sky-100 transition duration-200 ease-out hover:bg-sky-400/15 hover:-translate-y-px active:scale-[0.99] disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-600 sm:w-auto"
            disabled={currentAction !== "idle" || !manualInput.trim()}
          >
            Verify
          </button>
        </form>
      </div>

        {#if errorMessage}
          <div class="rounded-[1.6rem] border border-rose-300/30 bg-rose-950/60 px-4 py-3 text-sm text-rose-100 shadow-[0_18px_44px_rgba(127,29,29,0.2)] animate-fade-up-2">
            {errorMessage}
          </div>
        {/if}

      {#if currentAction === "checking"}
        <div class="grid place-items-center rounded-[1.75rem] border border-sky-300/15 bg-slate-950/70 px-4 py-10 text-center shadow-[0_24px_60px_rgba(3,10,22,0.55)] backdrop-blur-xl animate-fade-up-3">
          <div class="relative h-14 w-14">
            <div class="absolute inset-0 rounded-full border border-sky-300/20 bg-sky-400/5"></div>
            <div class="absolute inset-1.5 rounded-full border-2 border-slate-700 border-t-sky-300 animate-spin"></div>
            <div class="absolute inset-4.5 rounded-full bg-sky-300/30 blur-sm"></div>
          </div>
          <div class="mt-4 space-y-2">
            <p class="text-xs uppercase tracking-[0.24em] text-sky-100/55">Running arbitration</p>
            <p class="text-sm text-slate-300">Tracing brand ownership, physical origin, and parent structure...</p>
          </div>
        </div>
        {:else if evaluation}
          <div class="animate-fade-up-3">
            <VerificationCard result={evaluation} />
          </div>
          <button
            class="w-full rounded-2xl border border-sky-300/15 bg-slate-950/70 px-4 py-3 text-sm font-medium text-slate-100 transition duration-200 ease-out hover:border-sky-300/35 hover:bg-slate-900/80 hover:-translate-y-px active:scale-[0.99] animate-fade-up-3"
            onclick={reset}
          >
            Scan Another
          </button>
      {/if}
    </div>
  </section>
</main>
