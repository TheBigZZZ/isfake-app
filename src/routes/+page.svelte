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

<main class="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-linear-to-b from-slate-950 via-slate-900 to-slate-950">
  <div class="pointer-events-none absolute inset-0 opacity-40 [background:radial-gradient(90%_50%_at_20%_0%,rgba(245,158,11,0.18),transparent_65%)]"></div>

  <header class="relative z-10 shrink-0 px-4 pb-3 pt-5">
    <div class="mx-auto flex w-full max-w-md items-center justify-between gap-2">
      <h1 class="font-[Fraunces,serif] text-2xl leading-none text-amber-100">Global Brand Trace</h1>
      <span class="rounded-full border border-amber-900/60 bg-amber-950/40 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-amber-200/80">
        mobile
      </span>
    </div>
  </header>

  <section class="relative z-10 min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
    <div class="mx-auto flex w-full max-w-md flex-col gap-4 px-4 pb-4 pt-1">
      <div class:hidden={isScanning} class="rounded-3xl border border-slate-700/70 bg-slate-900/90 p-4 shadow-[0_18px_45px_rgba(0,0,0,0.32)] backdrop-blur">
        <button
          class="w-full rounded-2xl bg-amber-300 px-4 py-3.5 text-sm font-semibold text-slate-950 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
          onclick={startScan}
          disabled={currentAction !== "idle"}
        >
          {currentAction === "scanning" ? "Scanning..." : "Scan Product Barcode"}
        </button>

        <div class="my-4 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-slate-500">
          <span class="h-px flex-1 bg-slate-800"></span>
          <span>or enter manually</span>
          <span class="h-px flex-1 bg-slate-800"></span>
        </div>

        <form class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onsubmit={handleManualSubmit}>
          <input
            type="text"
            inputmode="numeric"
            bind:value={manualInput}
            placeholder="Barcode number"
            class="min-w-0 w-full rounded-2xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-300 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            disabled={currentAction !== "idle"}
          />
          <button
            type="submit"
            class="w-full shrink-0 rounded-2xl border border-amber-300/80 bg-transparent px-4 py-2.5 text-sm font-semibold text-amber-200 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-600 sm:w-auto"
            disabled={currentAction !== "idle" || !manualInput.trim()}
          >
            Verify
          </button>
        </form>
      </div>

        {#if errorMessage}
          <div class="rounded-3xl border border-rose-400/50 bg-rose-950/70 px-4 py-3 text-sm text-rose-100">
            {errorMessage}
          </div>
        {/if}

      {#if currentAction === "checking"}
        <div class="grid place-items-center rounded-3xl border border-slate-700/70 bg-slate-900/90 px-4 py-10 text-center shadow-[0_18px_45px_rgba(0,0,0,0.32)]">
          <div class="h-10 w-10 animate-spin rounded-full border-2 border-slate-700 border-t-amber-300"></div>
            <p class="mt-4 text-sm text-slate-300">Tracing brand ownership and origin country from search context...</p>
        </div>
        {:else if evaluation}
          <VerificationCard result={evaluation} />
          <button
            class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm font-medium text-slate-100 transition active:scale-[0.99]"
            onclick={reset}
          >
            Scan Another
          </button>
      {/if}
    </div>
  </section>
</main>
