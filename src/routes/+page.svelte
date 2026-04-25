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

<main class="flex h-full min-h-0 w-full flex-col overflow-hidden px-4 py-5">
  <div class="mx-auto flex w-full max-w-md flex-col gap-4">
    <header class="mb-2">
      <h1 class="font-[Fraunces,serif] text-3xl leading-none text-white">IsFake</h1>
    </header>

    <section class="rounded-2xl border border-sky-300/20 bg-slate-900 p-4">
      <div class:hidden={isScanning} class="space-y-4">
        <button
          class="w-full rounded-xl bg-sky-400 px-4 py-3 text-sm font-semibold text-slate-950 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
          onclick={startScan}
          disabled={currentAction !== "idle"}
        >
          {currentAction === "scanning" ? "Scanning..." : "Scan Product Barcode"}
        </button>

        <div class="my-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-slate-400">
          <span class="h-px flex-1 bg-slate-700"></span>
          <span>or enter manually</span>
          <span class="h-px flex-1 bg-slate-700"></span>
        </div>

        <form class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onsubmit={handleManualSubmit}>
          <input
            type="text"
            inputmode="numeric"
            bind:value={manualInput}
            placeholder="Barcode number"
            class="min-w-0 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={currentAction !== "idle"}
          />
          <button
            type="submit"
            class="w-full shrink-0 rounded-xl border border-sky-300/30 px-4 py-2.5 text-sm font-semibold text-sky-100 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-600 sm:w-auto"
            disabled={currentAction !== "idle" || !manualInput.trim()}
          >
            Verify
          </button>
        </form>
      </div>
    </section>

    {#if errorMessage}
      <div class="rounded-xl border border-rose-300/40 bg-rose-950 px-4 py-3 text-sm text-rose-100">
        {errorMessage}
      </div>
    {/if}

    {#if currentAction === "checking"}
      <div class="rounded-xl border border-slate-700 bg-slate-900 px-4 py-8 text-center text-sm text-slate-300">
        Checking barcode...
      </div>
    {:else if evaluation}
      <VerificationCard result={evaluation} />
      <button
        class="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-medium text-slate-100 transition active:scale-[0.99]"
        onclick={reset}
      >
        Scan Another
      </button>
    {/if}
  </div>
</main>
