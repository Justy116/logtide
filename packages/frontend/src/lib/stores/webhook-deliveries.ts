import { writable } from 'svelte/store';
import type { WebhookDelivery, WebhookDeliveryStatus } from '@logtide/shared';
import {
  listWebhookDeliveries,
  replayWebhookDelivery,
} from '$lib/api/webhook-deliveries';

export interface WebhookDeliveriesState {
  deliveries: WebhookDelivery[];
  loading: boolean;
  error: string | null;
  statusFilter: WebhookDeliveryStatus | '';
}

const initialState: WebhookDeliveriesState = {
  deliveries: [],
  loading: false,
  error: null,
  statusFilter: '',
};

function createWebhookDeliveriesStore() {
  const { subscribe, update } = writable<WebhookDeliveriesState>(initialState);

  return {
    subscribe,

    async load(organizationId: string, status?: WebhookDeliveryStatus) {
      update((s) => ({ ...s, loading: true, error: null, statusFilter: status ?? '' }));

      try {
        const deliveries = await listWebhookDeliveries({ organizationId, status });
        update((s) => ({ ...s, deliveries, loading: false }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to load deliveries';
        update((s) => ({ ...s, deliveries: [], loading: false, error: errorMessage }));
      }
    },

    async replay(organizationId: string, id: string) {
      try {
        await replayWebhookDelivery(id);
        // reload current filter state
        let currentStatus: WebhookDeliveryStatus | '' = '';
        update((s) => {
          currentStatus = s.statusFilter;
          return s;
        });
        const deliveries = await listWebhookDeliveries({
          organizationId,
          status: currentStatus || undefined,
        });
        update((s) => ({ ...s, deliveries }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to replay delivery';
        update((s) => ({ ...s, error: errorMessage }));
        throw error;
      }
    },
  };
}

export const webhookDeliveriesStore = createWebhookDeliveriesStore();
