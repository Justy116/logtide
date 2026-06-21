<script lang="ts">
  import "../app.css";
  import { Toaster } from "$lib/components/ui/sonner";
  import { ProgressBar } from "@prgm/sveltekit-progress-bar";
  import { afterNavigate } from "$app/navigation";
  import { hub } from "@logtide/core";
  import { createBoundaryHandler } from "@logtide/sveltekit";
  import { installAuthFetchInterceptor } from "$lib/api/fetch-interceptor";

  const onerror = createBoundaryHandler('RootLayout');

  // Install the global 401 handler once, before any API request fires.
  installAuthFetchInterceptor();

  // Track client-side navigations as page views
  afterNavigate(({ to, type }) => {
    const client = hub.getClient();
    if (!client || !to?.url) return;

    client.captureLog('info', `pageview ${to.url.pathname}`, {
      'page.url': to.url.href,
      'page.pathname': to.url.pathname,
      'navigation.type': type,
    });
  });
</script>

<ProgressBar class="text-primary" zIndex={100} />
<Toaster />
<svelte:boundary {onerror}>
  <slot />
  {#snippet failed(error, reset)}
    <div class="min-h-screen flex items-center justify-center p-4 bg-background">
      <div class="text-center space-y-4">
        <h1 class="text-4xl font-bold text-destructive">Something went wrong</h1>
        <p class="text-muted-foreground">An unexpected error occurred.</p>
        <button class="px-4 py-2 bg-primary text-primary-foreground rounded-md" onclick={reset}>
          Try again
        </button>
      </div>
    </div>
  {/snippet}
</svelte:boundary>
