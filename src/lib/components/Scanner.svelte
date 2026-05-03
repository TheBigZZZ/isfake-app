<script lang="ts">
  import type { VerificationResult } from "$lib/verification";

  interface Props {
    evaluation: VerificationResult | null;
    guidance: any;
    errorMessage: string | null;
    onStartScan: () => void;
    onClose: () => void;
    openCameraCapture: () => void;
    handleCameraSelection: (event: Event) => void;
  }

  let { evaluation, guidance, errorMessage, onStartScan, onClose, openCameraCapture, handleCameraSelection }: Props = $props();
</script>

<div class="fixed inset-0 bg-black">
  <!-- Camera Viewfinder -->
  <div class="relative w-full h-full flex flex-col">
    <!-- Black viewfinder background -->
    <div class="flex-1 bg-black relative flex items-center justify-center overflow-hidden">
      <!-- Dashed focus guide frame -->
      <div class="absolute w-[86%] h-[64%] border-2 border-dashed border-gray-500 rounded-lg"></div>
      
      <!-- "Scan mode" label (top-left) -->
      <div class="absolute top-4 left-4 text-xs text-white bg-black bg-opacity-50 px-3 py-1 rounded">
        Scan mode
      </div>
      
      <!-- Center status text -->
      <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
        <p class="text-white text-sm">Position product in frame</p>
      </div>
      
      <!-- Bottom hint -->
      <div class="absolute bottom-6 left-0 right-0 text-center">
        <div class="inline-block text-xs text-white bg-black bg-opacity-50 px-3 py-1 rounded-full">
          Keep product flat and centered
        </div>
      </div>
    </div>

    <!-- Control buttons -->
    <div class="absolute bottom-8 left-0 right-0 flex items-center justify-center gap-6 z-10">
      <!-- Capture button (white circle with black dot) -->
      <button
        onclick={onStartScan}
        class="w-16 h-16 rounded-full bg-white flex items-center justify-center shadow-lg hover:scale-110 transition-transform"
        aria-label="Capture photo"
      >
        <div class="w-10 h-10 rounded-full bg-black"></div>
      </button>
      
      <!-- Upload button -->
      <button
        onclick={openCameraCapture}
        class="px-4 py-2 border border-white text-white text-sm font-medium rounded hover:bg-white hover:text-black transition"
        aria-label="Upload image"
      >
        📤 Upload
      </button>
    </div>

    <!-- Top control: Close button -->
    <button
      onclick={onClose}
      class="absolute top-4 right-4 text-white bg-black bg-opacity-50 px-3 py-2 rounded hover:bg-opacity-75 transition z-10"
      aria-label="Close scanner"
    >
      ✕ Close
    </button>
  </div>
</div>

<style>
  :global {
    body {
      overflow: hidden;
    }
  }
</style>
