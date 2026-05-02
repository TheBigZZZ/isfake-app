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

    <section class="relative overflow-hidden rounded-[1.75rem] border border-sky-300/15 bg-slate-950/70 p-5 shadow-[0_24px_80px_rgba(2,6,23,0.45)] backdrop-blur anim-in-1">
      <div class="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-sky-300/70 to-transparent"></div>
      <div class="space-y-4">
        <div class="rounded-3xl border border-sky-300/20 bg-[radial-gradient(circle_at_top,rgba(125,211,252,0.16),rgba(15,23,42,0.9)_62%)] p-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-[11px] uppercase tracking-[0.22em] text-sky-200/65">Primary action</p>
              <h2 class="mt-2 font-[Fraunces,serif] text-2xl leading-tight text-white">Hold the product up to the camera.</h2>
            </div>
            <div class="rounded-2xl border border-sky-300/20 bg-slate-950/70 px-3 py-2 text-right text-[11px] text-slate-300">
              <div class="text-sky-200">Brand</div>
              <div class="opacity-80">Parent company</div>
              <div class="opacity-80">Origin</div>
            </div>
          </div>

          <div class="mt-4 rounded-[1.25rem] border border-slate-700/70 bg-slate-950/70 p-4">
            <div class="flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-slate-400">
              <span>Viewfinder</span>
              <span>{currentAction === "camera" ? "Reading label" : "Ready"}</span>
            </div>
            <div class="mt-3 rounded-2xl border border-dashed border-sky-300/25 bg-[linear-gradient(135deg,rgba(15,23,42,0.7),rgba(2,6,23,0.95))] px-4 py-10 text-center">
              <div class="mx-auto mb-3 h-14 w-14 rounded-full border border-sky-300/30 bg-sky-400/10 p-3 shadow-[0_0_0_6px_rgba(56,189,248,0.05)]">
                <div class="h-full w-full rounded-full border-2 border-sky-200/70"></div>
              </div>
              <p class="text-sm font-medium text-slate-100">Scan the front label, not the barcode.</p>
              <p class="mt-1 text-xs leading-relaxed text-slate-400">OCR will extract product name, brand, parent company, and visible country text.</p>
            </div>
          </div>

          <div class="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              class="w-full rounded-xl bg-sky-300 px-4 py-3 text-sm font-semibold text-slate-950 transition duration-200 ease-out hover:-translate-y-px hover:bg-sky-200 active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
              onclick={startScan}
              disabled={currentAction !== "idle"}
            >
              {currentAction === "camera" ? "Reading label..." : "Open camera"}
            </button>
            <button
              class="rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm font-medium text-slate-200 transition duration-200 ease-out hover:-translate-y-px hover:border-sky-300/35 active:scale-[0.99]"
              onclick={openCameraCapture}
              disabled={currentAction !== "idle"}
            >
              Retake / upload
            </button>
          </div>
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
