<script lang="ts">
  import { onMount } from "svelte";
  import { App } from "@capacitor/app";
  import VerificationCard from "$lib/components/VerificationCard.svelte";
  import Scanner from "$lib/components/Scanner.svelte";
  import { signInWithGoogle, verifyScan, fetchRecentIdentifications } from "$lib/supabase";
  import type { VerificationResult } from "$lib/verification";

  type ScanGuidance = NonNullable<VerificationResult["scan_guidance"]>;

  interface RecentIdentification {
    id: string;
    product_name: string;
    status?: string;
    timestamp?: string;
  }

  let isScanning = $state(false);
  let evaluation = $state<VerificationResult | null>(null);
  let guidance = $state<ScanGuidance | null>(null);
  let currentAction = $state<"idle" | "checking" | "camera" | "manual-check">("idle");
  let errorMessage = $state<string | null>(null);
  let authMessage = $state<string | null>(null);
  let authBusy = $state(false);
  let searchQuery = $state("");
  let recentIdentifications = $state<RecentIdentification[]>([]);
  let cameraInput: HTMLInputElement | null = null;

  onMount(() => {
    loadRecentIdentifications();
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

  const loadRecentIdentifications = async () => {
    try {
      recentIdentifications = await fetchRecentIdentifications();
    } catch (error) {
      console.error("Failed to load recent identifications:", error);
    }
  };

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Unable to read camera image."));
      reader.readAsDataURL(file);
    });

  const triggerVerification = async (
    extras: { ocr_text?: string; image_data_url?: string; image_base64?: string; image_url?: string } = {},
    action: "checking" | "camera" | "manual-check" = "camera"
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
      loadRecentIdentifications();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Unable to process the camera image.";
    }
  };

  const handleManualCheck = async () => {
    if (!searchQuery.trim()) {
      errorMessage = "Please enter a product name or barcode.";
      return;
    }
    await triggerVerification({ ocr_text: searchQuery }, "manual-check");
    searchQuery = "";
    loadRecentIdentifications();
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

<main class="min-h-screen w-full bg-linear-to-b from-gray-50 to-white">
  {#if isScanning}
    <Scanner {evaluation} {guidance} {errorMessage} onStartScan={startScan} onClose={() => { isScanning = false; currentAction = "idle"; }} {openCameraCapture} {handleCameraSelection} />
  {:else if evaluation !== null}
    <div class="flex flex-col h-screen">
      <header class="border-b border-gray-200 bg-white px-4 py-3 flex items-center gap-3">
        <button onclick={reset} class="text-blue-600 hover:text-blue-700 font-medium">← Back</button>
        <h1 class="text-lg font-semibold text-gray-900">Verification Result</h1>
      </header>
      <div class="flex-1 overflow-y-auto p-4">
        <VerificationCard result={evaluation} />
      </div>
    </div>
  {:else}
    <!-- Home Screen: Circular Logo + Search + Recent Identifications -->
    <div class="flex flex-col h-screen px-4 py-6 gap-6">
      <!-- Circular Gradient Spinner Logo -->
      <div class="flex justify-center pt-4">
        <div class="relative w-24 h-24">
          <svg viewBox="0 0 100 100" class="w-full h-full">
            <defs>
              <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#0058be;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#00a8e8;stop-opacity:1" />
              </linearGradient>
            </defs>
            <!-- Circular spinner background -->
            <circle cx="50" cy="50" r="48" fill="none" stroke="#e5e7eb" stroke-width="2" />
            <!-- Animated gradient arc -->
            <circle
              cx="50"
              cy="50"
              r="48"
              fill="none"
              stroke="url(#logoGradient)"
              stroke-width="3"
              stroke-dasharray="150 226"
              class="animate-spin"
              style="animation: spin 2s linear infinite;"
            />
            <!-- Center text -->
            <text
              x="50"
              y="50"
              text-anchor="middle"
              dominant-baseline="middle"
              font-family="Manrope, sans-serif"
              font-size="32"
              font-weight="800"
              fill="#0f172a"
            >
              IF
            </text>
          </svg>
        </div>
      </div>

      <!-- Search Bar -->
      <div class="max-w-md mx-auto w-full">
        <div class="relative">
          <input
            type="text"
            placeholder="ENTER PRODUCT NAME / BARCODE"
            bind:value={searchQuery}
            onkeydown={(e) => e.key === "Enter" && handleManualCheck()}
            class="w-full px-4 py-3 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            onclick={handleManualCheck}
            disabled={currentAction !== "idle"}
            class="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Check
          </button>
        </div>
      </div>

      <!-- Scan Camera Button -->
      <div class="max-w-md mx-auto w-full flex gap-3">
        <button
          onclick={startScan}
          disabled={currentAction !== "idle"}
          class="flex-1 py-3 px-4 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          📷 Scan Camera
        </button>
        <button
          onclick={openCameraCapture}
          disabled={currentAction !== "idle"}
          class="flex-1 py-3 px-4 border border-gray-300 text-gray-900 font-semibold rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          📤 Upload
        </button>
      </div>

      <!-- Error Message -->
      {#if errorMessage}
        <div class="max-w-md mx-auto w-full p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {errorMessage}
        </div>
      {/if}

      {#if authMessage}
        <div class="max-w-md mx-auto w-full p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {authMessage}
        </div>
      {/if}

      <!-- Recent Identifications -->
      <div class="flex-1 max-w-md mx-auto w-full overflow-y-auto">
        <div>
          <h2 class="text-sm font-bold uppercase tracking-wider text-gray-700 mb-4">RECENT_IDENTIFICATIONS</h2>
          {#if recentIdentifications.length > 0}
            <div class="space-y-3">
              {#each recentIdentifications as item (item.id)}
                <button
                  onclick={() => {
                    searchQuery = item.product_name;
                    handleManualCheck();
                  }}
                  class="w-full text-left p-4 border border-gray-200 rounded-lg bg-white hover:bg-blue-50 hover:border-blue-200 cursor-pointer transition"
                >
                  <p class="font-semibold text-gray-900">{item.product_name}</p>
                  <p class="text-sm text-gray-600 mt-1">{item.status || "Verified"}</p>
                  {#if item.timestamp}
                    <p class="text-xs text-gray-500 mt-2">{new Date(item.timestamp).toLocaleDateString()}</p>
                  {/if}
                </button>
              {/each}
            </div>
          {:else}
            <p class="text-gray-600 text-sm">No recent identifications yet. Start by scanning a product or entering a name.</p>
          {/if}
        </div>
      </div>

      <!-- Sign In Section -->
      <div class="max-w-md mx-auto w-full pb-4">
        <div class="border-t border-gray-200 pt-4">
          <button
            onclick={startGoogleSignIn}
            disabled={authBusy}
            class="w-full py-3 px-4 bg-white border border-gray-300 text-gray-900 font-semibold rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
          >
            {#if authBusy}
              <span class="animate-spin">⏳</span> Signing in...
            {:else}
              🔑 Sign in with Google
            {/if}
          </button>
        </div>
      </div>
    </div>
  {/if}
</main>

<input
  type="file"
  accept="image/*"
  capture="environment"
  bind:this={cameraInput}
  onchange={handleCameraSelection}
  class="hidden"
/>

<style>
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
