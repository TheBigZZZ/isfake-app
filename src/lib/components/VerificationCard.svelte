<script lang="ts">
  import type { VerificationResult } from '$lib/verification';

  interface Props {
    result?: VerificationResult | null;
  }

  let { result = null }: Props = $props();

  let expanded = $state(false);
  let copying = $state(false);

  function getVerifiedName() {
    return result?.product_identity?.verified_name ?? result?.product_name ?? 'Unknown Product';
  }

  function getBrand() {
    return result?.product_identity?.brand ?? result?.brand ?? '';
  }

  function confidencePct() {
    const score = result?.product_identity?.confidence_score ?? result?.confidence_score ?? 0;
    return Math.round(score * 100);
  }

  function isFlagged() {
    return result ? (result.compliance?.is_flagged ?? result.is_flagged) : false;
  }

  async function copyBarcode() {
    if (!result?.barcode) return;
    try {
      copying = true;
      await navigator.clipboard.writeText(result.barcode);
    } catch {
      // ignore
    } finally {
      copying = false;
    }
  }
</script>

<div class="verification-card">
  {#if !result}
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Checking product...</p>
    </div>
  {:else}
    <!-- Status Header -->
    <div class="status-header" class:flagged={isFlagged()} class:clear={!isFlagged()}>
      <div class="status-badge">
        {isFlagged() ? '⚠️ FLAGGED' : '✓ CLEAR'}
      </div>
      <div class="status-label">
        {isFlagged() ? 'Product flagged for compliance issues' : 'Product verification passed'}
      </div>
    </div>

    <!-- Product Name -->
    <div class="product-section">
      <h2 class="product-name">{getVerifiedName()}</h2>
      {#if getBrand()}
        <p class="product-brand">{getBrand()}</p>
      {/if}
      {#if result.barcode}
        <div class="barcode-section">
          <code class="barcode">{result.barcode}</code>
          <button
            onclick={copyBarcode}
            class="copy-button"
            title="Copy barcode"
          >
            {copying ? '✓ Copied' : '📋 Copy'}
          </button>
        </div>
      {/if}
    </div>

    <!-- Metrics Grid -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">CATEGORY</div>
        <div class="metric-value">
          {result.product_identity?.category ?? '—'}
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-label">CONFIDENCE</div>
        <div class="metric-value">
          {confidencePct()}%
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-label">PHYSICAL ORIGIN</div>
        <div class="metric-value">
          {result.origin_details?.physical_origin_country ?? result.origin_country ?? '—'}
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-label">LEGAL PREFIX</div>
        <div class="metric-value">
          {result.origin_details?.legal_registration_prefix ?? '—'}
        </div>
      </div>
    </div>

    <!-- Corporate Structure -->
    <div class="corporate-section">
      <h3 class="section-title">Corporate Structure</h3>
      <div class="corp-grid">
        <div class="corp-field">
          <div class="corp-label">Ultimate Parent Company</div>
          <div class="corp-value">
            {result.corporate_structure?.ultimate_parent_company ?? result.parent_company ?? '—'}
          </div>
        </div>
        <div class="corp-field">
          <div class="corp-label">Parent HQ Country</div>
          <div class="corp-value">
            {result.corporate_structure?.global_hq_country ?? result.holding_company_hq ?? '—'}
          </div>
        </div>
      </div>
    </div>

    <!-- Compliance Status -->
    <div class="compliance-section" class:flagged={isFlagged()}>
      <div class="compliance-header">
        <h3 class="section-title">Compliance Status</h3>
        <span class="compliance-badge" class:flagged={isFlagged()}>
          {isFlagged() ? 'FLAGGED' : 'CLEAR'}
        </span>
      </div>
      {#if isFlagged() && (result.compliance?.flag_reason ?? result.flag_reason)}
        <div class="flag-reason">
          <strong>Reason:</strong> {result.compliance?.flag_reason ?? result.flag_reason}
        </div>
      {/if}
    </div>

    <!-- Arbitration Log (Expandable) -->
    <div class="arbitration-section">
      <button
        onclick={() => (expanded = !expanded)}
        class="disclosure-button"
        aria-expanded={expanded}
      >
        {expanded ? '▼ Hide' : '▶ Show'} Full Analysis
      </button>
      {#if expanded}
        <div class="arbitration-log">
          <pre>{result.arbitration_log ?? result.reasoning ?? 'No detailed analysis available.'}</pre>
        </div>
      {/if}
    </div>

    <!-- Error Section -->
    {#if result.error}
      <div class="error-section">
        <p class="error-message">⚠️ {result.error}</p>
        <button class="retry-button">Retry Verification</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .verification-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 24px;
    max-width: 100%;
    font-family: 'Inter', sans-serif;
    color: #1f2937;
    line-height: 1.6;
  }

  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    gap: 16px;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid #e5e7eb;
    border-top-color: #0058be;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Status Header */
  .status-header {
    padding: 16px;
    border-radius: 8px;
    margin-bottom: 24px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .status-header.flagged {
    background-color: #fff7ed;
    border: 1px solid #fed7aa;
  }

  .status-header.clear {
    background-color: #f0fdf4;
    border: 1px solid #bbf7d0;
  }

  .status-badge {
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.05em;
  }

  .status-header.flagged .status-badge {
    color: #b45309;
  }

  .status-header.clear .status-badge {
    color: #166534;
  }

  .status-label {
    font-size: 13px;
    opacity: 0.8;
  }

  /* Product Section */
  .product-section {
    margin-bottom: 28px;
  }

  .product-name {
    margin: 0 0 8px 0;
    font-size: 28px;
    font-weight: 700;
    line-height: 1.2;
    color: #0f172a;
    font-family: 'Manrope', sans-serif;
  }

  .product-brand {
    margin: 0 0 12px 0;
    font-size: 14px;
    color: #6b7280;
  }

  .barcode-section {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    padding: 8px 12px;
    background-color: #f9fafb;
    border-radius: 6px;
  }

  .barcode {
    font-family: 'Space Grotesk', monospace;
    font-size: 12px;
    color: #6b7280;
    margin: 0;
  }

  .copy-button {
    margin-left: auto;
    padding: 4px 8px;
    background: none;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .copy-button:hover {
    background-color: #f3f4f6;
    border-color: #0058be;
    color: #0058be;
  }

  /* Metrics Grid */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 28px;
  }

  .metric-card {
    padding: 12px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background-color: #fafbfc;
  }

  .metric-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #6b7280;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .metric-value {
    font-size: 16px;
    font-weight: 600;
    color: #0f172a;
  }

  /* Corporate Structure */
  .corporate-section {
    margin-bottom: 28px;
    padding-bottom: 28px;
    border-bottom: 1px solid #e5e7eb;
  }

  .section-title {
    margin: 0 0 16px 0;
    font-size: 16px;
    font-weight: 700;
    color: #0f172a;
    font-family: 'Manrope', sans-serif;
  }

  .corp-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .corp-field {
    padding: 12px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background-color: #fafbfc;
  }

  .corp-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #6b7280;
    text-transform: uppercase;
    margin-bottom: 6px;
  }

  .corp-value {
    font-size: 14px;
    color: #0f172a;
  }

  /* Compliance Status */
  .compliance-section {
    margin-bottom: 28px;
    padding: 16px;
    border-radius: 8px;
    background-color: #f9fafb;
  }

  .compliance-section.flagged {
    background-color: #fff7ed;
    border: 1px solid #fed7aa;
  }

  .compliance-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .compliance-badge {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 6px 12px;
    border-radius: 6px;
    background-color: #dbeafe;
    color: #0c4a6e;
  }

  .compliance-badge.flagged {
    background-color: #fed7aa;
    color: #b45309;
  }

  .flag-reason {
    font-size: 14px;
    color: #6b7280;
    line-height: 1.6;
  }

  /* Arbitration Log */
  .arbitration-section {
    margin-bottom: 28px;
    border-top: 1px solid #e5e7eb;
    padding-top: 20px;
  }

  .disclosure-button {
    background: none;
    border: none;
    padding: 8px 0;
    font-size: 14px;
    font-weight: 600;
    color: #0058be;
    cursor: pointer;
    transition: color 0.2s;
  }

  .disclosure-button:hover {
    color: #0041a8;
  }

  .arbitration-log {
    margin-top: 12px;
    padding: 12px;
    background-color: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    max-height: 400px;
    overflow-y: auto;
  }

  .arbitration-log pre {
    margin: 0;
    font-family: 'Space Grotesk', monospace;
    font-size: 12px;
    color: #6b7280;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Error Section */
  .error-section {
    margin-top: 20px;
    padding: 16px;
    background-color: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 8px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .error-message {
    margin: 0;
    flex: 1;
    font-size: 14px;
    color: #991b1b;
  }

  .retry-button {
    padding: 8px 16px;
    background-color: #ef4444;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .retry-button:hover {
    background-color: #dc2626;
  }

  @media (max-width: 640px) {
    .verification-card {
      padding: 16px;
    }

    .metrics-grid {
      grid-template-columns: 1fr;
    }

    .product-name {
      font-size: 24px;
    }
  }
</style>
