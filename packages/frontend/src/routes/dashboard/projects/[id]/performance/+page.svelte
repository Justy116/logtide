<script lang="ts">
  import { page } from '$app/state';
  import { browser } from '$app/environment';
  import { currentOrganization } from '$lib/stores/organization';
  import { logsAPI } from '$lib/api/logs';
  import WebVitalsWidget from '$lib/components/dashboard/WebVitalsWidget.svelte';
  import Spinner from '$lib/components/Spinner.svelte';

  const projectId = $derived(page.params.id);

  let webVitalsMetrics = $state<Array<{ name: string; value: number; rating: 'good' | 'needs-improvement' | 'poor'; unit: string }>>([]);
  let loading = $state(true);
  let lastLoadedKey = $state<string | null>(null);

  async function loadWebVitals() {
    if (!$currentOrganization || !projectId) return;

    loading = true;

    try {
      const now = new Date();
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const response = await logsAPI.getLogs({
        projectId,
        q: 'Web Vital:',
        searchMode: 'substring',
        from: from.toISOString(),
        to: now.toISOString(),
        limit: 100,
      });

      const latest = new Map<string, { value: number; rating: string }>();
      for (const log of response.logs) {
        const meta = log.metadata;
        if (!meta || !meta['performance.metric']) continue;
        const name = String(meta['performance.metric']);
        if (!latest.has(name)) {
          latest.set(name, {
            value: Number(meta['performance.value']),
            rating: String(meta['performance.rating'] || 'good'),
          });
        }
      }

      const metricOrder = ['LCP', 'INP', 'CLS'];
      webVitalsMetrics = metricOrder
        .filter((name) => latest.has(name))
        .map((name) => {
          const data = latest.get(name)!;
          return {
            name,
            value: data.value,
            rating: data.rating as 'good' | 'needs-improvement' | 'poor',
            unit: name === 'CLS' ? '' : 'ms',
          };
        });

      lastLoadedKey = `${$currentOrganization.id}-${projectId}`;
    } catch {
      webVitalsMetrics = [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (!browser || !$currentOrganization || !projectId) {
      webVitalsMetrics = [];
      lastLoadedKey = null;
      return;
    }

    const key = `${$currentOrganization.id}-${projectId}`;
    if (key === lastLoadedKey) return;

    loadWebVitals();
  });
</script>

<svelte:head>
  <title>Project Performance - LogTide</title>
</svelte:head>

<div class="space-y-6">
  {#if loading}
    <div class="flex items-center justify-center py-24">
      <Spinner />
      <span class="ml-3 text-muted-foreground">Loading performance data...</span>
    </div>
  {:else}
    <div class="grid gap-4 md:grid-cols-2">
      <WebVitalsWidget metrics={webVitalsMetrics} />
    </div>
  {/if}
</div>
