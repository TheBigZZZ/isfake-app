<script lang="ts">
  import { onMount } from "svelte";
  import { App } from "@capacitor/app";
  import VerificationCard from "$lib/components/VerificationCard.svelte";
  import { signInWithGoogle, verifyScan } from "$lib/supabase";
  import type { VerificationResult } from "$lib/verification";

  type ScanGuidance = NonNullable<VerificationResult["scan_guidance"]>;

  let isScanning = $state(false);
  let evaluation = $state<VerificationResult | null>(null);
  let guidance = $state<ScanGuidance | null>(null);
  let currentAction = $state<"idle" | "checking" | "camera">("idle");
  let errorMessage = $state<string | null>(null);
  let authMessage = $state<string | null>(null);
  let authBusy = $state(false);
  let cameraInput: HTMLInputElement | null = null;

  onMount(() => {
    const backBtnListener = App.addListener("backButton", () => {
      if (isScanning) {
        isScanning = false;
        currentAction = "idle";
      } else if (evaluation !== null) {
        evaluation = null;
        guidance = null;
      } else {
        App.exitApp();
      }
    });
    return () => { backBtnListener.then(l => l.remove()); };
  });

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Unable to read camera image."));
      reader.readAsDataURL(file);
    });

  const triggerVerification = async (
    extras: { ocr_text?: string; image_data_url?: string; image_base64?: string; image_url?: string } = {},
    action: "checking" | "camera" = "camera"
  ) => {
    currentAction = action;
    errorMessage = null;
    evaluation = null;
    guidance = null;
    try {
      evaluation = await verifyScan(undefined, extras);
      guidance = evaluation.scan_guidance ?? null;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Verification failed.";
      evaluation = null;
      guidance = null;
    } finally {
      currentAction = "idle";
    }
  };

  const startScan = async () => {
    isScanning = true;
    currentAction = "camera";
    evaluation = null;
    guidance = null;

    openCameraCapture();
    isScanning = false;
    if (currentAction === "camera") currentAction = "idle";
  };

  const openCameraCapture = () => {
    cameraInput?.click();
  };

  const handleCameraSelection = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";

    if (!file) return;

    try {
      const imageDataUrl = await readFileAsDataUrl(file);
      await triggerVerification({ image_data_url: imageDataUrl }, "camera");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Unable to process the camera image.";
    }
  };

  const reset = () => {
    evaluation = null;
    guidance = null;
    currentAction = "idle";
    errorMessage = null;
  };

  const startGoogleSignIn = async () => {
    authBusy = true;
    authMessage = null;

    try {
      const { error } = await signInWithGoogle();
      if (error) {
        authMessage = error.message;
      }
    } catch (error) {
      authMessage = error instanceof Error ? error.message : "Unable to start Google sign-in.";
    } finally {
      authBusy = false;
    }
  };
</script>

<main class="relative flex h-full min-h-0 w-full flex-col overflow-x-hidden overflow-y-auto px-4 py-5 text-slate-100">
  <div class="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.12),transparent_38%),linear-gradient(180deg,#020617_0%,#0f172a_58%,#020617_100%)]"></div>
  <div class="mx-auto flex w-full max-w-md flex-col gap-4">
    <header class="anim-in flex items-end justify-between gap-4">
      <div>
        <p class="text-[11px] uppercase tracking-[0.28em] text-sky-200/70">Camera-first product scanner</p>
        <h1 class="font-[Fraunces,serif] text-3xl leading-none text-white">IsFake</h1>
      </div>
      <div class="rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-sky-100">
        Live OCR
      </div>
    </header>

    <section class="anim-in-1 rounded-3xl border border-sky-300/15 bg-slate-950/60 p-4 backdrop-blur">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p class="text-[11px] uppercase tracking-[0.24em] text-sky-200/65">Sign in</p>
          <p class="mt-1 text-sm leading-relaxed text-slate-300">Use Google to sign in with Supabase Auth and keep your session across scans.</p>
        </div>
        <button
          class="rounded-xl bg-white px-4 py-3 text-sm font-semibold text-slate-950 transition duration-200 ease-out hover:-translate-y-px hover:bg-slate-200 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
          onclick={startGoogleSignIn}
          disabled={authBusy}
        >
          {authBusy ? "Connecting..." : "Continue with Google"}
        </button>
      </div>
      {#if authMessage}
        <p class="mt-3 text-sm text-rose-200">{authMessage}</p>
      {/if}
    </section>

    <section class="relative overflow-hidden rounded-[1.75rem] border border-slate-700/20 bg-slate-950/60 p-5 shadow-[0_24px_80px_rgba(2,6,23,0.45)] backdrop-blur anim-in-1">
      <div class="grid gap-4">
        <div class="hero p-4 rounded-2xl border border-slate-700/20">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-[11px] uppercase tracking-[0.22em] text-slate-400">Primary action</p>
              <h2 class="mt-2 text-2xl leading-tight text-white">Hold the product up to the camera.</h2>
              <p class="mt-2 text-sm text-slate-300">OCR will extract the product name, brand, parent company, and visible country text. Scan the front label, not the barcode.</p>
            </div>
            <div class="meta text-right text-sm text-slate-300">
              <div class="font-medium">Brand</div>
              <div class="opacity-80">Parent company</div>
              <div class="opacity-80">Origin</div>
            </div>
          </div>

          <div class="mt-4">
            <div class="edge-viewfinder relative w-full overflow-hidden rounded-2xl bg-black" style="aspect-ratio: 3/4;">
              <!-- Focus guide -->
              <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div class="w-[86%] h-[64%] border-2 border-dashed border-slate-600/60 rounded-lg"></div>
              </div>

              <!-- Top overlay: small status / hint -->
              <div class="absolute left-3 top-3 rounded-md bg-black/40 px-2 py-1 text-xs text-slate-200">Scan mode</div>

              <!-- Center status (reads label) -->
              <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div class="text-center">
                  <p class="text-sm font-medium text-white">{currentAction === 'camera' ? 'Reading label...' : 'Ready'}</p>
                </div>
              </div>

              <!-- Bottom hint strip -->
              <div class="absolute left-0 right-0 bottom-0 p-3 flex justify-center pointer-events-none">
                <div class="rounded-full bg-black/40 px-3 py-1 text-xs text-slate-200">Keep product flat and centered</div>
              </div>
            </div>

            <div class="mt-3 flex items-center justify-center gap-6">
              <button class="w-16 h-16 rounded-full bg-white shadow-lg flex items-center justify-center" onclick={startScan} aria-label="Capture" disabled={currentAction !== 'idle'}>
                <div class="w-10 h-10 rounded-full bg-black"></div>
              </button>
              <button class="rounded-md px-3 py-2 border border-slate-700 text-sm" onclick={openCameraCapture} disabled={currentAction !== 'idle'}>Upload</button>
            </div>
          </div>

          <div class="mt-4 flex flex-col gap-2 sm:flex-row">
            <button class="w-full rounded-xl bg-slate-200/5 px-4 py-3 text-sm font-semibold text-white" onclick={startScan} disabled={currentAction !== 'idle'}>
              {currentAction === 'camera' ? 'Reading label...' : 'Open camera'}
            </button>
            <button class="rounded-xl border border-slate-700 bg-transparent px-4 py-3 text-sm" onclick={openCameraCapture} disabled={currentAction !== 'idle'}>
              Retake / upload
            </button>
          </div>
        </div>

        <div class="result-area">
          {#if currentAction === 'checking' || currentAction === 'camera'}
            <div class="rounded-xl border border-slate-700 bg-slate-900 px-4 py-8 text-center text-sm text-slate-300">
              <div class="mx-auto mb-3 h-6 w-6 rounded-full border-2 border-slate-600 border-t-slate-300 animate-spin"></div>
              <p>{currentAction === 'camera' ? 'Reading label...' : 'Checking product...'}</p>
            </div>
          {:else}
            <div class="rounded-xl">
              <VerificationCard result={evaluation} compact={!evaluation} />
            </div>
            <div class="mt-3">
              <button class="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm" onclick={reset}>Scan Another</button>
            </div>
          {/if}
        </div>
      </div>
    </section>

    {#if errorMessage}
      <div class="rounded-xl border border-rose-300/40 bg-rose-950 px-4 py-3 text-sm text-rose-100 anim-in-2">
        {errorMessage}
      </div>
    {/if}

    {#if guidance}
      <div class="rounded-2xl border border-sky-300/20 bg-slate-900 px-4 py-4 text-sm text-slate-200 anim-in-2">
        <p class="text-[11px] uppercase tracking-[0.18em] text-slate-400">Camera fallback</p>
        <p class="mt-2 leading-relaxed">{guidance.message}</p>
        <div class="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            class="rounded-xl border border-sky-300/30 px-4 py-2.5 text-sm font-semibold text-sky-100 transition duration-200 ease-out hover:-translate-y-px hover:bg-slate-800 active:scale-[0.99]"
            onclick={openCameraCapture}
            disabled={currentAction !== "idle"}
          >
            Open camera
          </button>
          <button
            class="rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm font-medium text-slate-200 transition duration-200 ease-out hover:-translate-y-px hover:border-sky-300/35 active:scale-[0.99]"
            onclick={reset}
            disabled={currentAction !== "idle"}
          >
            Start over
          </button>
        </div>
      </div>
    {/if}

    {#if currentAction === "checking" || currentAction === "camera"}
      <div class="rounded-xl border border-slate-700 bg-slate-900 px-4 py-8 text-center text-sm text-slate-300 anim-in-2">
        <div class="mx-auto mb-3 h-6 w-6 rounded-full border-2 border-slate-600 border-t-sky-300 animate-spin"></div>
        <p class="anim-pulse-soft">{currentAction === "camera" ? "Reading label..." : "Checking product..."}</p>
      </div>
    {:else if evaluation}
      <div class="anim-in-2">
        <VerificationCard result={evaluation} />
      </div>
      <button
        class="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-medium text-slate-100 transition duration-200 ease-out hover:-translate-y-px hover:border-sky-300/35 active:scale-[0.99]"
        onclick={reset}
      >
        Scan Another
      </button>
    {/if}

    <div class="rounded-2xl border border-sky-300/15 bg-slate-950/60 px-4 py-3 text-xs leading-relaxed text-slate-400">
      If OCR misses the label, move closer and keep the product flat in the frame. Barcode scanning is now only a silent fallback inside the API.
    </div>

    <input bind:this={cameraInput} class="hidden" type="file" accept="image/*" capture="environment" onchange={handleCameraSelection} />
  </div>
</main>
