<script lang="ts">
  import "./layout.css";

  let { children } = $props();
</script>
<svelte:head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<div class="h-dvh w-full overflow-hidden bg-slate-950 text-slate-100 antialiased font-[Manrope,sans-serif]">
  {@render children()}
</div>
