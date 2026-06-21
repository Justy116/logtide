<script lang="ts">
  import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '$lib/components/ui/dialog';
  import Button from '$lib/components/ui/button/button.svelte';
  import Input from '$lib/components/ui/input/input.svelte';
  import Label from '$lib/components/ui/label/label.svelte';
  import Textarea from '$lib/components/ui/textarea/textarea.svelte';
  import Spinner from './Spinner.svelte';
  import * as Alert from '$lib/components/ui/alert';
  import Plus from '@lucide/svelte/icons/plus';
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import { checklistStore } from '$lib/stores/checklist';
  import { copyToClipboard } from '$lib/utils/clipboard';
  import { getApiUrl } from '$lib/config';
  import type { ApiKeyType } from '$lib/api/api-keys';

  interface Props {
    onSubmit: (data: { name: string; type: ApiKeyType; allowedOrigins: string[] | null }) => Promise<{ apiKey: string; type: ApiKeyType; message: string }>;
    open?: boolean;
  }

  let { onSubmit, open = $bindable(false) }: Props = $props();
  let name = $state('');
  let keyType = $state<ApiKeyType>('write');
  let originsRaw = $state('');
  let submitting = $state(false);
  let error = $state('');
  let generatedApiKey = $state<string | null>(null);
  let generatedKeyType = $state<ApiKeyType>('write');
  let copied = $state(false);
  let copiedDsn = $state(false);
  let apiUrlValue = $state('http://localhost:8080');

  $effect(() => {
    apiUrlValue = getApiUrl() || window.location.origin;
  });

  let dsn = $derived.by(() => {
    if (!generatedApiKey) return '';
    const scheme = apiUrlValue.startsWith('http://') ? 'http' : 'https';
    const host = apiUrlValue.replace(/^https?:\/\//, '');
    return `${scheme}://${generatedApiKey}@${host}`;
  });

  function parseOrigins(raw: string): string[] | null {
    const list = raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : null;
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    error = '';

    submitting = true;
    try {
      const result = await onSubmit({
        name: name.trim(),
        type: keyType,
        allowedOrigins: parseOrigins(originsRaw),
      });

      generatedApiKey = result.apiKey;
      generatedKeyType = result.type;

      // Mark checklist item as complete
      checklistStore.completeItem('create-api-key');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create API key';
    } finally {
      submitting = false;
    }
  }

  async function handleCopy() {
    if (!generatedApiKey) return;

    const success = await copyToClipboard(generatedApiKey);

    if (success) {
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } else {
      error = 'Could not copy to clipboard. Please select the key and copy manually (Ctrl+C / Cmd+C).';
    }
  }

  async function handleCopyDsn() {
    if (!dsn) return;

    const success = await copyToClipboard(dsn);

    if (success) {
      copiedDsn = true;
      setTimeout(() => {
        copiedDsn = false;
      }, 2000);
    } else {
      error = 'Could not copy to clipboard. Please select the DSN and copy manually (Ctrl+C / Cmd+C).';
    }
  }

  function handleClose() {
    name = '';
    keyType = 'write';
    originsRaw = '';
    generatedApiKey = null;
    generatedKeyType = 'write';
    error = '';
    copied = false;
    copiedDsn = false;
    open = false;
  }

  $effect(() => {
    if (!open) {
      name = '';
      keyType = 'write';
      originsRaw = '';
      generatedApiKey = null;
      generatedKeyType = 'write';
      error = '';
      copied = false;
      copiedDsn = false;
    }
  });
</script>

<Dialog bind:open>
  <DialogContent class="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
    {#if !generatedApiKey}
      <DialogHeader>
        <DialogTitle>Create API Key</DialogTitle>
        <DialogDescription>
          Create a new API key for this project. You'll be able to use it to send logs programmatically.
        </DialogDescription>
      </DialogHeader>

      <form onsubmit={handleSubmit} class="space-y-4 py-4">
        <div class="space-y-2">
          <Label for="api-key-name">API Key Name</Label>
          <Input
            id="api-key-name"
            type="text"
            placeholder="Production API Key"
            bind:value={name}
            disabled={submitting}
            required
            autofocus
          />
          <p class="text-xs text-muted-foreground">
            Choose a descriptive name to identify this key later.
          </p>
        </div>

        <div class="space-y-2">
          <Label>Key Type</Label>
          <div class="grid grid-cols-2 gap-3">
            <button
              type="button"
              class="rounded-md border p-3 text-left transition-colors {keyType === 'write'
                ? 'border-primary bg-primary/5'
                : 'border-input hover:border-primary/50'}"
              onclick={() => (keyType = 'write')}
            >
              <div class="font-medium text-sm">Write-Only</div>
              <div class="text-xs text-muted-foreground mt-1">
                Can only ingest logs. Safe for client-side use.
              </div>
            </button>
            <button
              type="button"
              class="rounded-md border p-3 text-left transition-colors {keyType === 'full'
                ? 'border-primary bg-primary/5'
                : 'border-input hover:border-primary/50'}"
              onclick={() => (keyType = 'full')}
            >
              <div class="font-medium text-sm">Full Access</div>
              <div class="text-xs text-muted-foreground mt-1">
                Can ingest logs and query data. Server-side only.
              </div>
            </button>
          </div>
        </div>

        <div class="space-y-2">
          <Label for="allowed-origins">
            Allowed Origins / IPs
            <span class="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Textarea
            id="allowed-origins"
            placeholder={"https://app.example.com\n192.168.1.0\n*.mycompany.com"}
            bind:value={originsRaw}
            disabled={submitting}
            rows={3}
          />
          <p class="text-xs text-muted-foreground">
            One per line or comma-separated. Leave empty for no restriction.
            Matches Origin header (browsers) or request IP (servers).
          </p>
        </div>

        {#if error}
          <div class="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
            {error}
          </div>
        {/if}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onclick={handleClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={submitting || !name.trim()}
            class="gap-2"
          >
            {#if submitting}
              <Spinner size="sm" />
              Creating...
            {:else}
              <Plus class="w-4 h-4" />
              Create API Key
            {/if}
          </Button>
        </DialogFooter>
      </form>
    {:else}
      <DialogHeader>
        <DialogTitle>API Key Created</DialogTitle>
        <DialogDescription>
          Your API key has been created successfully.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4 py-4">
        <Alert.Root variant="destructive">
          <Alert.Title>Important: Save this key now</Alert.Title>
          <Alert.Description>
            This is the only time you'll see this key. Copy it and store it securely.
            If you lose it, you'll need to create a new one.
          </Alert.Description>
        </Alert.Root>

        <div class="space-y-2">
          <Label>Your API Key</Label>
          <div class="flex gap-2 items-start">
            <div class="flex-1 min-w-0">
              <div class="relative">
                <div class="font-mono text-sm bg-muted border border-input rounded-md px-3 py-2 break-all select-all cursor-text overflow-x-auto">
                  {generatedApiKey}
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              onclick={handleCopy}
              class="gap-2 shrink-0"
            >
              {#if copied}
                <Check class="w-4 h-4" />
                Copied
              {:else}
                <Copy class="w-4 h-4" />
                Copy
              {/if}
            </Button>
          </div>
        </div>

        <div class="space-y-2">
          <Label>DSN <span class="text-muted-foreground font-normal text-xs">(for @logtide/core SDK)</span></Label>
          <div class="flex gap-2 items-start">
            <div class="flex-1 min-w-0">
              <div class="font-mono text-xs bg-muted border border-input rounded-md px-3 py-2 break-all select-all cursor-text overflow-x-auto">
                {dsn}
              </div>
            </div>
            <Button
              variant="outline"
              onclick={handleCopyDsn}
              class="gap-2 shrink-0"
            >
              {#if copiedDsn}
                <Check class="w-4 h-4" />
                Copied
              {:else}
                <Copy class="w-4 h-4" />
                Copy
              {/if}
            </Button>
          </div>
        </div>

        <div class="text-sm text-muted-foreground">
          Key type: <span class="font-medium">
            {generatedKeyType === 'write' ? 'Write-Only' : 'Full Access'}
          </span>
        </div>

        <div class="bg-muted p-3 rounded-md space-y-1">
          <p class="text-xs font-medium">Usage Example:</p>
          <pre class="text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap break-all"><code>curl -X POST {apiUrlValue}/api/v1/ingest \
  -H "X-API-Key: {generatedApiKey}" \
  -d '{`{"logs": [...]}`}'</code></pre>
        </div>
      </div>

      <DialogFooter>
        <Button onclick={handleClose} class="gap-2">
          Done
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>
