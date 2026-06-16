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

  it('uses payload.id as eventId when it starts with evt_ and no explicit eventId', async () => {
    const envelopeId = 'evt_a1b2c3d4-0000-0000-0000-000000000001';
    await webhookDispatcher.enqueue({
      url: 'https://e.com/hook',
      payload: { id: envelopeId, type: 'alert.triggered', version: 1 },
      organizationId: 'org-1',
      eventType: 'alert.triggered',
    });
    expect(createDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: envelopeId })
    );
  });

  it('same envelope object enqueued twice produces the same jobKey (dedup)', async () => {
    const envelopeId = 'evt_a1b2c3d4-0000-0000-0000-000000000002';
    const args = {
      url: 'https://e.com/hook',
      payload: { id: envelopeId, type: 'alert.triggered', version: 1 },
      organizationId: 'org-1',
      eventType: 'alert.triggered',
    };
    await webhookDispatcher.enqueue(args);
    const key1 = addMock.mock.calls[0][2].jobKey;
    addMock.mockClear(); createDeliveryMock.mockClear();
    await webhookDispatcher.enqueue(args);
    expect(addMock.mock.calls[0][2].jobKey).toBe(key1);
  });

  it('envelopes with different ids produce different jobKeys (no false dedup)', async () => {
    const args1 = {
      url: 'https://e.com/hook',
      payload: { id: 'evt_aaaaaaaa-0000-0000-0000-000000000001', type: 'alert.triggered', version: 1 },
      organizationId: 'org-1',
      eventType: 'alert.triggered',
    };
    const args2 = {
      ...args1,
      payload: { id: 'evt_bbbbbbbb-0000-0000-0000-000000000002', type: 'alert.triggered', version: 1 },
    };
    await webhookDispatcher.enqueue(args1);
    const key1 = addMock.mock.calls[0][2].jobKey;
    addMock.mockClear(); createDeliveryMock.mockClear();
    await webhookDispatcher.enqueue(args2);
    expect(addMock.mock.calls[0][2].jobKey).not.toBe(key1);
  });

  it('falls back to hash when payload.id exists but does not start with evt_', async () => {
    await webhookDispatcher.enqueue({
      url: 'https://e.com/hook',
      payload: { id: 'not-an-envelope-id' },
      organizationId: 'org-1',
      eventType: 'alert',
    });
    // eventId in the createDelivery call should be the hash (32 hex chars), not the plain id
    const call = createDeliveryMock.mock.calls[0][0];
    expect(call.eventId).toMatch(/^[0-9a-f]{32}$/);
    expect(call.eventId).not.toBe('not-an-envelope-id');
  });
});
