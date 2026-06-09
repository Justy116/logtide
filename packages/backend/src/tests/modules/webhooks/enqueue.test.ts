import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addMock, createDeliveryMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  createDeliveryMock: vi.fn(),
}));

vi.mock('../../../queue/connection.js', () => ({
  createQueue: vi.fn(() => ({ add: addMock, close: vi.fn() })),
}));

vi.mock('../../../modules/webhooks/service.js', () => ({
  webhookDeliveryService: { createDelivery: createDeliveryMock },
}));

vi.mock('../../../config/index.js', () => ({ config: { WEBHOOK_MAX_ATTEMPTS: 5 } }));

import { webhookDispatcher } from '../../../modules/webhooks/dispatcher.js';

beforeEach(() => {
  addMock.mockReset().mockResolvedValue({ id: 'job-1' });
  createDeliveryMock.mockReset().mockResolvedValue({ id: 'del-1' });
});

describe('webhookDispatcher.enqueue', () => {
  it('persists a delivery and enqueues a job with a deterministic jobKey', async () => {
    await webhookDispatcher.enqueue({
      url: 'https://e.com/hook', payload: { a: 1 }, organizationId: 'org-1', eventType: 'alert', eventId: 'evt-9',
    });
    expect(createDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', eventType: 'alert', eventId: 'evt-9', url: 'https://e.com/hook', maxAttempts: 5,
    }));
    const [, jobData, opts] = addMock.mock.calls[0];
    expect(jobData).toEqual({ deliveryId: 'del-1' });
    // jobKey must be deterministic and contain no ':' (BullMQ forbids it in job ids).
    expect(opts.jobKey).toMatch(/^webhook-[0-9a-f]{64}$/);
  });

  it('builds the same jobKey for the same org/eventType/eventId', async () => {
    const args = { url: 'https://e.com/hook', payload: { a: 1 }, organizationId: 'org-1', eventType: 'alert', eventId: 'evt-9' };
    await webhookDispatcher.enqueue(args);
    const key1 = addMock.mock.calls[0][2].jobKey;
    addMock.mockClear(); createDeliveryMock.mockClear();
    await webhookDispatcher.enqueue(args);
    expect(addMock.mock.calls[0][2].jobKey).toBe(key1);
  });

  it('derives a stable eventId when none is given', async () => {
    await webhookDispatcher.enqueue({ url: 'https://e.com', payload: { a: 1 }, organizationId: 'o', eventType: 'alert' });
    const firstKey = addMock.mock.calls[0][2].jobKey;
    addMock.mockClear(); createDeliveryMock.mockClear();
    await webhookDispatcher.enqueue({ url: 'https://e.com', payload: { a: 1 }, organizationId: 'o', eventType: 'alert' });
    expect(addMock.mock.calls[0][2].jobKey).toBe(firstKey);
  });
});
