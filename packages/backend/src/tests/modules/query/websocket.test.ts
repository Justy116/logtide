import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import crypto from 'node:crypto';
import { db } from '../../../database/index.js';
import websocketRoutes from '../../../modules/query/websocket.js';
import { notificationManager } from '../../../modules/streaming/index.js';
import { createTestContext, createTestLog } from '../../helpers/factories.js';
import type { LogNotificationEvent } from '../../../modules/streaming/index.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function createTestSession(userId: string) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insertInto('sessions').values({ user_id: userId, token, expires_at: expiresAt }).execute();
    return { token };
}

/** Wait for the ws client to close, resolving with { code, reason }. */
function waitForClose(ws: any, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('waitForClose timed out')), timeoutMs);
        ws.on('close', (code: number, reason: Buffer) => {
            clearTimeout(t);
            resolve({ code, reason: reason.toString() });
        });
    });
}

/** Wait for the next 'message' event, resolving with the parsed payload. */
function waitForMessage(ws: any, timeoutMs = 3000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('waitForMessage timed out')), timeoutMs);
        ws.once('message', (data: Buffer | string) => {
            clearTimeout(t);
            resolve(JSON.parse(data.toString()));
        });
    });
}

/** Resolve after at most `ms` ms without requiring an event (for "no message" assertions). */
function noMessageFor(ws: any, ms = 200): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        ws.once('message', () => {
            clearTimeout(t);
            reject(new Error('received unexpected message'));
        });
    });
}

// ---------------------------------------------------------------------------
// test setup
// ---------------------------------------------------------------------------

describe('WebSocket route /api/v1/logs/ws', () => {
    let app: FastifyInstance;
    let testUser: any;
    let testProject: any;
    let authToken: string;

    beforeAll(async () => {
        app = Fastify({ logger: false });
        // Register @fastify/websocket (same as src/plugins/websocket.ts but without fp() wrapper)
        await app.register(websocket);
        await app.register(websocketRoutes);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        const ctx = await createTestContext();
        testUser = ctx.user;
        testProject = ctx.project;
        const session = await createTestSession(testUser.id);
        authToken = session.token;
    });

    // -------------------------------------------------------------------------
    // auth: missing token
    // -------------------------------------------------------------------------

    describe('auth: missing token', () => {
        it('closes immediately when token is absent', async () => {
            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}`,
            );
            const { code } = await waitForClose(ws);
            expect(code).toBe(1008);
        });
    });

    // -------------------------------------------------------------------------
    // auth: invalid / expired token
    // -------------------------------------------------------------------------

    describe('auth: invalid token', () => {
        it('closes with 1008 for an unknown token', async () => {
            const fakeToken = crypto.randomBytes(32).toString('hex');
            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${fakeToken}`,
            );
            const { code } = await waitForClose(ws);
            expect(code).toBe(1008);
        });

        it('closes with 1008 for an expired token', async () => {
            const expiredToken = crypto.randomBytes(32).toString('hex');
            // Insert a session that is already expired
            await db.insertInto('sessions').values({
                user_id: testUser.id,
                token: expiredToken,
                expires_at: new Date(Date.now() - 1000), // 1 second in the past
            }).execute();

            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${expiredToken}`,
            );
            const { code } = await waitForClose(ws);
            expect(code).toBe(1008);
        });
    });

    // -------------------------------------------------------------------------
    // auth: missing projectId
    // -------------------------------------------------------------------------

    describe('projectId validation', () => {
        it('closes with 1008 when projectId is absent', async () => {
            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?token=${authToken}`,
            );
            const { code } = await waitForClose(ws);
            expect(code).toBe(1008);
        });
    });

    // -------------------------------------------------------------------------
    // tenant isolation: project access
    // -------------------------------------------------------------------------

    describe('tenant isolation', () => {
        it('closes with 1008 when the user is not a member of the project\'s organization', async () => {
            // testUser/authToken belong to the org created in beforeEach. Create a
            // separate org+project and try to live-tail it with the first user's token.
            const otherCtx = await createTestContext();

            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${otherCtx.project.id}&token=${authToken}`,
            );
            const { code } = await waitForClose(ws);
            expect(code).toBe(1008);
        });

        it('allows a user to subscribe to a project in their own organization', async () => {
            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}`,
            );
            const msg = await waitForMessage(ws) as any;
            expect(msg.type).toBe('connected');
            ws.terminate();
        });
    });

    // -------------------------------------------------------------------------
    // valid session: connection established
    // -------------------------------------------------------------------------

    describe('valid session', () => {
        it('sends a connected message on successful upgrade', async () => {
            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}`,
            );
            const msg = await waitForMessage(ws) as any;
            expect(msg.type).toBe('connected');
            expect(typeof msg.subscriberId).toBe('string');
            ws.terminate();
        });

        it('registers a subscriber with the notification manager', async () => {
            const before = notificationManager.getStatus().subscriberCount;
            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}`,
            );
            // consume 'connected' message
            await waitForMessage(ws);

            const during = notificationManager.getStatus().subscriberCount;
            expect(during).toBeGreaterThan(before);

            ws.terminate();
        });
    });

    // -------------------------------------------------------------------------
    // notification delivery
    // -------------------------------------------------------------------------

    describe('notification delivery', () => {
        it('delivers a matching log to a subscribed client', async () => {
            const log = await createTestLog({
                projectId: testProject.id,
                service: 'api',
                level: 'error',
                message: 'something bad',
            });

            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}`,
            );
            // consume 'connected' message
            await waitForMessage(ws);

            // Directly invoke the registered subscriber callback
            const subscribers = Array.from((notificationManager as any).subscribers.values()) as any[];
            const sub = subscribers.find((s: any) => s.projectId === testProject.id);
            expect(sub).toBeDefined();

            const event: LogNotificationEvent = {
                projectId: testProject.id,
                logIds: [log.id],
                timestamp: new Date().toISOString(),
            };

            const msgPromise = waitForMessage(ws);
            await sub.onNotification(event);

            const msg = await msgPromise as any;
            expect(msg.type).toBe('logs');
            expect(msg.logs).toHaveLength(1);
            expect(msg.logs[0].id).toBe(log.id);
            expect(msg.logs[0].service).toBe('api');
            expect(msg.logs[0].level).toBe('error');

            ws.terminate();
        });

        it('does not deliver a log when logIds returns no rows', async () => {
            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}`,
            );
            await waitForMessage(ws); // connected

            const subscribers = Array.from((notificationManager as any).subscribers.values()) as any[];
            const sub = subscribers.find((s: any) => s.projectId === testProject.id);

            const event: LogNotificationEvent = {
                projectId: testProject.id,
                logIds: [crypto.randomUUID()], // non-existent id
                timestamp: new Date().toISOString(),
            };

            await sub.onNotification(event);
            await noMessageFor(ws, 300);

            ws.terminate();
        });
    });

    // -------------------------------------------------------------------------
    // filter: service
    // -------------------------------------------------------------------------

    describe('service filter', () => {
        it('delivers a log whose service matches the filter', async () => {
            const log = await createTestLog({
                projectId: testProject.id,
                service: 'payments',
                level: 'info',
            });

            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}&service=payments`,
            );
            await waitForMessage(ws); // connected

            const subscribers = Array.from((notificationManager as any).subscribers.values()) as any[];
            const sub = subscribers.find((s: any) => s.projectId === testProject.id);

            const event: LogNotificationEvent = {
                projectId: testProject.id,
                logIds: [log.id],
                timestamp: new Date().toISOString(),
            };

            const msgPromise = waitForMessage(ws);
            await sub.onNotification(event);
            const msg = await msgPromise as any;

            expect(msg.type).toBe('logs');
            expect(msg.logs[0].service).toBe('payments');

            ws.terminate();
        });

        it('does NOT deliver a log that does not match the service filter', async () => {
            // seed a log for 'auth' service
            const log = await createTestLog({
                projectId: testProject.id,
                service: 'auth',
                level: 'info',
            });

            // connect with filter for 'payments' only
            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}&service=payments`,
            );
            await waitForMessage(ws); // connected

            const subscribers = Array.from((notificationManager as any).subscribers.values()) as any[];
            const sub = subscribers.find((s: any) => s.projectId === testProject.id);

            const event: LogNotificationEvent = {
                projectId: testProject.id,
                logIds: [log.id],
                timestamp: new Date().toISOString(),
            };

            await sub.onNotification(event);
            await noMessageFor(ws, 300);

            ws.terminate();
        });
    });

    // -------------------------------------------------------------------------
    // filter: level
    // -------------------------------------------------------------------------

    describe('level filter', () => {
        it('does NOT deliver a log at the wrong level', async () => {
            const log = await createTestLog({
                projectId: testProject.id,
                service: 'api',
                level: 'debug',
            });

            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}&level=error`,
            );
            await waitForMessage(ws); // connected

            const subscribers = Array.from((notificationManager as any).subscribers.values()) as any[];
            const sub = subscribers.find((s: any) => s.projectId === testProject.id);

            const event: LogNotificationEvent = {
                projectId: testProject.id,
                logIds: [log.id],
                timestamp: new Date().toISOString(),
            };

            await sub.onNotification(event);
            await noMessageFor(ws, 300);

            ws.terminate();
        });

        it('delivers a log at the correct level', async () => {
            const log = await createTestLog({
                projectId: testProject.id,
                service: 'api',
                level: 'warn',
            });

            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}&level=warn`,
            );
            await waitForMessage(ws); // connected

            const subscribers = Array.from((notificationManager as any).subscribers.values()) as any[];
            const sub = subscribers.find((s: any) => s.projectId === testProject.id);

            const event: LogNotificationEvent = {
                projectId: testProject.id,
                logIds: [log.id],
                timestamp: new Date().toISOString(),
            };

            const msgPromise = waitForMessage(ws);
            await sub.onNotification(event);
            const msg = await msgPromise as any;
            expect(msg.logs[0].level).toBe('warn');

            ws.terminate();
        });
    });

    // -------------------------------------------------------------------------
    // filter: hostname (metadata)
    // -------------------------------------------------------------------------

    describe('hostname filter', () => {
        it('does NOT deliver a log with a non-matching hostname', async () => {
            const log = await createTestLog({
                projectId: testProject.id,
                service: 'api',
                level: 'info',
                metadata: { hostname: 'host-b' },
            });

            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}&hostname=host-a`,
            );
            await waitForMessage(ws); // connected

            const subscribers = Array.from((notificationManager as any).subscribers.values()) as any[];
            const sub = subscribers.find((s: any) => s.projectId === testProject.id);

            const event: LogNotificationEvent = {
                projectId: testProject.id,
                logIds: [log.id],
                timestamp: new Date().toISOString(),
            };

            await sub.onNotification(event);
            await noMessageFor(ws, 300);

            ws.terminate();
        });

        it('delivers a log with a matching hostname', async () => {
            const log = await createTestLog({
                projectId: testProject.id,
                service: 'api',
                level: 'info',
                metadata: { hostname: 'host-a' },
            });

            const ws = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}&hostname=host-a`,
            );
            await waitForMessage(ws); // connected

            const subscribers = Array.from((notificationManager as any).subscribers.values()) as any[];
            const sub = subscribers.find((s: any) => s.projectId === testProject.id);

            const event: LogNotificationEvent = {
                projectId: testProject.id,
                logIds: [log.id],
                timestamp: new Date().toISOString(),
            };

            const msgPromise = waitForMessage(ws);
            await sub.onNotification(event);
            const msg = await msgPromise as any;
            expect(msg.logs[0].id).toBe(log.id);

            ws.terminate();
        });
    });

    // -------------------------------------------------------------------------
    // cleanup: close unsubscribes
    // -------------------------------------------------------------------------

    describe('cleanup on close', () => {
        it('subscriber count drops after the websocket connection closes', async () => {
            // Connect two independent clients
            const ws1 = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${testProject.id}&token=${authToken}`,
            );
            const msg1 = await waitForMessage(ws1) as any;
            const id1: string = msg1.subscriberId;

            // Create a second session / context for ws2
            const ctx2 = await createTestContext();
            const session2 = await createTestSession(ctx2.user.id);
            const ws2 = await (app as any).injectWS(
                `/api/v1/logs/ws?projectId=${ctx2.project.id}&token=${session2.token}`,
            );
            await waitForMessage(ws2); // consume 'connected'

            // Both subscribers should be registered
            expect((notificationManager as any).subscribers.has(id1)).toBe(true);
            expect(notificationManager.getStatus().subscriberCount).toBeGreaterThanOrEqual(2);

            // Terminate ws1 and wait for the server-side close handler
            // The server socket emits 'close' which calls cleanup() -> unsubscribe()
            const removedPromise = new Promise<void>((resolve, reject) => {
                const deadline = setTimeout(() => reject(new Error('unsubscribe did not fire')), 5000);
                const interval = setInterval(() => {
                    if (!(notificationManager as any).subscribers.has(id1)) {
                        clearInterval(interval);
                        clearTimeout(deadline);
                        resolve();
                    }
                }, 10);
            });

            // Destroy the underlying socket stream so the server-side 'close' fires
            ws1._socket?.destroy();
            // Also terminate to clean the ws object itself
            try { ws1.terminate(); } catch { /* already gone */ }

            await removedPromise;
            expect((notificationManager as any).subscribers.has(id1)).toBe(false);

            ws2.terminate();
        });
    });
});
