<script lang="ts">
  import { onMount } from "svelte";
  import { CapacitorBarcodeScanner } from "@capacitor/barcode-scanner";
  import { App } from "@capacitor/app";
  import { verifyBarcode } from "$lib/supabase";

  let isScanning = $state(false);
  let manualInput = $state("");
  
  type ScanResultType = {
      status: string;
      source: string;
      reason: string;
      productName: string;
      brandName?: string;
      imageUrl?: string;
      category?: string;
      ingredients?: string;
      nutriScore?: string;
      novaGroup?: string;
      ecoScore?: string;
      ingredientsAnalysis?: string[];
      nutrientLevels?: Record<string, string>;
  } | null;

  let scanResult = $state<string | null>(null);
  let evaluation = $state<ScanResultType>(null);
  let currentAction = $state<"idle" | "scanning" | "checking">("idle");

  onMount(() => {
    const backBtnListener = App.addListener("backButton", () => {
      if (isScanning) {
        isScanning = false;
        currentAction = "idle";
      } else if (evaluation !== null) {
        evaluation = null;
        scanResult = null;
      } else {
        App.exitApp();
      }
    });
    return () => { backBtnListener.then(l => l.remove()); };
  });

  const triggerVerification = async (barcode: string) => {
    if (!barcode) return;
    currentAction = "checking";
    scanResult = barcode;
    evaluation = null;
    evaluation = await verifyBarcode(barcode);
    currentAction = "idle";
  };

  const startScan = async () => {
    isScanning = true;
    currentAction = "scanning";
    scanResult = null;
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
    scanResult = null;
    manualInput = "";
    currentAction = "idle";
  };
</script>

<main class="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-linear-to-b from-slate-950 via-slate-900 to-slate-950">
  <div class="pointer-events-none absolute inset-0 opacity-40 [background:radial-gradient(90%_50%_at_20%_0%,rgba(245,158,11,0.18),transparent_65%)]"></div>

  <header class="relative z-10 shrink-0 px-4 pb-3 pt-5">
    <div class="mx-auto flex w-full max-w-md items-center justify-between gap-2">
      <h1 class="font-[Fraunces,serif] text-2xl leading-none text-amber-100">Israel Checker</h1>
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

      {#if currentAction === "checking"}
        <div class="grid place-items-center rounded-3xl border border-slate-700/70 bg-slate-900/90 px-4 py-10 text-center shadow-[0_18px_45px_rgba(0,0,0,0.32)]">
          <div class="h-10 w-10 animate-spin rounded-full border-2 border-slate-700 border-t-amber-300"></div>
          <p class="mt-4 text-sm text-slate-300">Analyzing product origins and nutrition data...</p>
        </div>
      {:else if evaluation && scanResult}
        <article class="overflow-hidden rounded-3xl border border-slate-700/70 bg-slate-900/95 shadow-[0_22px_50px_rgba(0,0,0,0.36)] backdrop-blur">
          <div
            class={`h-1 w-full ${
              evaluation.status === "israeli"
                ? "bg-rose-500"
                : evaluation.status === "safe"
                  ? "bg-emerald-400"
                  : "bg-slate-700"
            }`}
          ></div>

          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3">
            <span
              class={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest ${
                evaluation.status === "israeli"
                  ? "border-rose-400 bg-rose-950 text-rose-300"
                  : evaluation.status === "safe"
                    ? "border-emerald-400 bg-emerald-950 text-emerald-300"
                    : "border-slate-600 bg-slate-800 text-slate-300"
              }`}
            >
              {evaluation.status === "israeli"
                ? "Restricted"
                : evaluation.status === "safe"
                  ? "Verified Safe"
                  : evaluation.status === "error"
                    ? "Error"
                    : "Unknown"}
            </span>
            <span class="max-w-full break-all text-[11px] uppercase tracking-widest text-slate-500">
              {evaluation.source}
            </span>
          </div>

          <div class="space-y-4 px-4 py-4">
            <div class="space-y-1">
              <h2 class="wrap-break-word font-[Fraunces,serif] text-3xl leading-[1.05] text-slate-100">{evaluation.productName}</h2>
              {#if evaluation.brandName && evaluation.brandName !== "N/A" && evaluation.brandName !== "UNKNOWN BRAND"}
                <p class="wrap-break-word text-xs uppercase tracking-[0.16em] text-amber-300">{evaluation.brandName}</p>
              {/if}
              <p class="text-xs text-slate-400">
                Barcode:
                <span class="break-all font-mono text-[11px] text-slate-300">{scanResult}</span>
              </p>
            </div>

            <p class="rounded-2xl border border-slate-800 bg-slate-950/90 px-3 py-2.5 text-sm leading-relaxed text-slate-300">
              {evaluation.reason}
            </p>

            <div class="grid grid-cols-3 gap-2">
              <div class="min-w-0 rounded-2xl border border-slate-800 bg-slate-950/90 p-2 text-center">
                <p class="truncate text-[10px] uppercase tracking-[0.12em] text-slate-500">Nutri</p>
                <p class="wrap-break-word font-[Fraunces,serif] text-[1.35rem] leading-none text-slate-100">{evaluation.nutriScore || "N/A"}</p>
              </div>
              <div class="min-w-0 rounded-2xl border border-slate-800 bg-slate-950/90 p-2 text-center">
                <p class="truncate text-[10px] uppercase tracking-[0.12em] text-slate-500">NOVA</p>
                <p class="wrap-break-word font-[Fraunces,serif] text-[1.35rem] leading-none text-slate-100">{evaluation.novaGroup || "N/A"}</p>
              </div>
              <div class="min-w-0 rounded-2xl border border-slate-800 bg-slate-950/90 p-2 text-center">
                <p class="truncate text-[10px] uppercase tracking-[0.12em] text-slate-500">Eco</p>
                <p class="wrap-break-word font-[Fraunces,serif] text-[1.35rem] leading-none text-slate-100">{evaluation.ecoScore || "N/A"}</p>
              </div>
            </div>

            {#if evaluation.nutrientLevels && Object.keys(evaluation.nutrientLevels).length > 0}
              <section class="space-y-2">
                <h3 class="text-xs uppercase tracking-[0.16em] text-slate-500">Nutrient Levels</h3>
                <div class="space-y-2">
                  {#each Object.entries(evaluation.nutrientLevels) as [nutrient, level] (nutrient)}
                    <div class="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-950/90 px-3 py-2 text-sm">
                      <span class="min-w-0 flex-1 truncate capitalize text-slate-300">{nutrient.replace("-", " ")}</span>
                      <span
                        class={`shrink-0 rounded-full px-2 py-0.5 text-xs uppercase ${
                          level === "high"
                            ? "bg-rose-950 text-rose-300"
                            : level === "moderate"
                              ? "bg-amber-950 text-amber-300"
                              : level === "low"
                                ? "bg-emerald-950 text-emerald-300"
                                : "bg-slate-800 text-slate-300"
                        }`}
                      >
                        {level}
                      </span>
                    </div>
                  {/each}
                </div>
              </section>
            {/if}

            {#if evaluation.ingredientsAnalysis && evaluation.ingredientsAnalysis.length > 0}
              <section class="space-y-2">
                <h3 class="text-xs uppercase tracking-[0.16em] text-slate-500">Ingredients Analysis</h3>
                <div class="flex flex-wrap gap-2">
                  {#each evaluation.ingredientsAnalysis as tag (tag)}
                    <span class="max-w-full wrap-break-word rounded-full border border-slate-700 bg-slate-950/90 px-2.5 py-1 text-xs text-slate-300">
                      {tag.replace("en:", "").replaceAll("-", " ")}
                    </span>
                  {/each}
                </div>
              </section>
            {/if}

            <button
              class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm font-medium text-slate-100 transition active:scale-[0.99]"
              onclick={reset}
            >
              Scan Another
            </button>
          </div>
        </article>
      {/if}
    </div>
  </section>
</main>
