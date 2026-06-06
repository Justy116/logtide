import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { processAlertNotification, type AlertNotificationData } from '../../../queue/jobs/alert-notification.js';
import { hooks, HookRejectionError } from '../../../hooks/index.js';
import { db } from '../../../database/index.js';
import { createTestContext, createTestUser } from '../../helpers/factories.js';

// Mock nodemailer
vi.mock('nodemailer', () => ({
    default: {
        createTransport: vi.fn(() => ({
            sendMail: vi.fn().mockResolvedValue({}),
        })),
    },
}));

// Mock fetch for webhooks
const mockFetch = vi.fn();
global.fetch = mockFetch;

// safeFetch normally resolves DNS, validates against the SSRF range check and
// revalidates every redirect hop. In these unit tests we don't hit the network
// or DNS: re-run the real IP-range check for IP-literal hosts so the SSRF-block
// assertions stay meaningful, treat hostnames as external, and delegate the
// actual request to the mocked global.fetch (with the original string URL, which
// the payload/header assertions rely on). Full DNS + redirect-hop coverage lives
// in ssrf-guard.test.ts. SsrfBlockedError stays the real class.
vi.mock('../../../utils/ssrf-guard.js', async (importOriginal) => {
    const actual: any = await importOriginal();
    const { isIP } = await import('net');
    return {
        ...actual,
        safeFetch: async (rawUrl: string, init: any) => {
            const raw = new URL(rawUrl).hostname;
            const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
            if (isIP(host) && actual.isBlockedAddress(host)) {
                throw new actual.SsrfBlockedError(`Target address ${host} is in a blocked range`);
            }
            return (global.fetch as any)(rawUrl, init);
        },
    };
});

// Mock alertsService
vi.mock('../../../modules/alerts/index.js', () => ({
    alertsService: {
        markAsNotified: vi.fn().mockResolvedValue(undefined),
    },
}));

// Mock notificationChannelsService
const mockGetAlertRuleChannels = vi.fn().mockResolvedValue([]);
vi.mock('../../../modules/notification-channels/index.js', () => ({
    notificationChannelsService: {
        getAlertRuleChannels: (...args: unknown[]) => mockGetAlertRuleChannels(...args),
    },
}));

// Mock config
vi.mock('../../../config/index.js', () => ({
    config: {
        SMTP_HOST: 'smtp.test.com',
        SMTP_PORT: 587,
        SMTP_USER: 'test@test.com',
        SMTP_PASS: 'password',
        SMTP_FROM: 'alerts@test.com',
        SMTP_SECURE: false,
        REDIS_URL: 'redis://localhost:6379',
        CACHE_ENABLED: true,
        CACHE_TTL: 60,
        FRONTEND_URL: 'https://app.logtide.dev',
        NODE_ENV: 'test',
    },
}));

describe('Alert Notification Job', () => {
    beforeEach(async () => {
        // Clean up in correct order (respecting foreign keys)
        await db.deleteFrom('logs').execute();
        await db.deleteFrom('alert_history').execute();
        await db.deleteFrom('sigma_rules').execute();
        await db.deleteFrom('alert_rules').execute();
        await db.deleteFrom('api_keys').execute();
        await db.deleteFrom('notifications').execute();
        await db.deleteFrom('organization_members').execute();
        await db.deleteFrom('projects').execute();
        await db.deleteFrom('organizations').execute();
        await db.deleteFrom('sessions').execute();
        await db.deleteFrom('users').execute();

        vi.clearAllMocks();
        mockFetch.mockReset();
        mockGetAlertRuleChannels.mockReset();
        mockGetAlertRuleChannels.mockResolvedValue([]);
        hooks.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        hooks.clear();
    });

    describe('processAlertNotification', () => {
        it('should create in-app notifications for organization members', async () => {
            const { organization, project, user } = await createTestContext();

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Test Alert Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            // Check that in-app notification was created
            const notifications = await db
                .selectFrom('notifications')
                .selectAll()
                .where('user_id', '=', user.id)
                .execute();

            expect(notifications.length).toBeGreaterThan(0);
            expect(notifications[0].title).toContain('Test Alert Rule');
        });

        it('should send email notification when email channel is configured', async () => {
            const { organization, project } = await createTestContext();

            // Mock notification channel with email recipients
            mockGetAlertRuleChannels.mockResolvedValueOnce([{
                id: '00000000-0000-0000-0000-000000000010',
                type: 'email',
                enabled: true,
                config: { recipients: ['admin@example.com', 'ops@example.com'] },
            }]);

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Email Alert Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            const consoleSpy = vi.spyOn(console, 'log');

            await processAlertNotification({ data: jobData });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Email notifications sent')
            );
        });

        it('should send webhook notification when webhook channel is configured', async () => {
            const { organization, project } = await createTestContext();

            mockFetch.mockResolvedValueOnce({
                ok: true,
                statusText: 'OK',
            });

            // Mock notification channel with webhook
            mockGetAlertRuleChannels.mockResolvedValueOnce([{
                id: '00000000-0000-0000-0000-000000000010',
                type: 'webhook',
                enabled: true,
                config: { url: 'https://hooks.example.com/alert' },
            }]);

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Webhook Alert Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            expect(mockFetch).toHaveBeenCalledWith(
                'https://hooks.example.com/alert',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
                })
            );
        });

        it('should handle webhook failure gracefully', async () => {
            const { organization, project } = await createTestContext();
            const { alertsService } = await import('../../../modules/alerts/index.js');

            mockFetch.mockResolvedValueOnce({
                ok: false,
                statusText: 'Internal Server Error',
            });

            // Mock notification channel with webhook
            mockGetAlertRuleChannels.mockResolvedValueOnce([{
                id: '00000000-0000-0000-0000-000000000010',
                type: 'webhook',
                enabled: true,
                config: { url: 'https://hooks.example.com/failing' },
            }]);

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Failing Webhook Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            // Should mark as notified with error
            expect(alertsService.markAsNotified).toHaveBeenCalledWith(
                jobData.historyId,
                expect.stringContaining('Webhook failed')
            );
        });

        it('should skip email when no recipients configured', async () => {
            const { organization, project } = await createTestContext();

            const consoleSpy = vi.spyOn(console, 'log');

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'No Email Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('No email recipients configured')
            );
        });

        it('should skip webhook when no URL configured', async () => {
            const { organization, project } = await createTestContext();

            const consoleSpy = vi.spyOn(console, 'log');

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'No Webhook Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('No webhook configured')
            );
        });

        it('should include project name in notification when project_id is provided', async () => {
            const { organization, project, user } = await createTestContext();

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Project Alert Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            const notifications = await db
                .selectFrom('notifications')
                .selectAll()
                .where('user_id', '=', user.id)
                .execute();

            expect(notifications.length).toBeGreaterThan(0);
            expect(notifications[0].message).toContain('project');
        });

        it('should handle missing organization members gracefully', async () => {
            // Create an organization without any members
            const user = await createTestUser();
            const orgResult = await db
                .insertInto('organizations')
                .values({
                    name: 'Empty Org',
                    slug: `empty-org-${Date.now()}`,
                    owner_id: user.id,
                })
                .returningAll()
                .executeTakeFirstOrThrow();

            const consoleSpy = vi.spyOn(console, 'log');

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Empty Org Alert',
                organization_id: orgResult.id,
                project_id: null,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('No members found')
            );
        });

        it('should send both email and webhook notifications', async () => {
            const { organization, project } = await createTestContext();

            mockFetch.mockResolvedValueOnce({
                ok: true,
                statusText: 'OK',
            });

            // Mock notification channels with both email and webhook
            mockGetAlertRuleChannels.mockResolvedValueOnce([
                {
                    id: '00000000-0000-0000-0000-000000000010',
                    type: 'email',
                    enabled: true,
                    config: { recipients: ['admin@example.com'] },
                },
                {
                    id: '00000000-0000-0000-0000-000000000011',
                    type: 'webhook',
                    enabled: true,
                    config: { url: 'https://hooks.example.com/alert' },
                },
            ]);

            const consoleSpy = vi.spyOn(console, 'log');

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Full Notification Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Email notifications sent')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Webhook notification sent')
            );
            expect(mockFetch).toHaveBeenCalled();
        });

        it('should include correct data in webhook payload', async () => {
            const { organization, project } = await createTestContext();

            mockFetch.mockResolvedValueOnce({
                ok: true,
                statusText: 'OK',
            });

            // Mock notification channel with webhook
            mockGetAlertRuleChannels.mockResolvedValueOnce([{
                id: '00000000-0000-0000-0000-000000000010',
                type: 'webhook',
                enabled: true,
                config: { url: 'https://hooks.example.com/alert' },
            }]);

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Webhook Payload Test',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 150,
                threshold: 100,
                time_window: 10,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            const callArgs = mockFetch.mock.calls[0];
            const body = JSON.parse(callArgs[1].body);

            expect(body.alert_name).toBe('Webhook Payload Test');
            expect(body.log_count).toBe(150);
            expect(body.threshold).toBe(100);
            expect(body.time_window).toBe(10);
            expect(body.timestamp).toBeDefined();
        });

        it('should ignore legacy email_recipients field and only use channels', async () => {
            const { organization, project } = await createTestContext();

            // No channels configured
            mockGetAlertRuleChannels.mockResolvedValueOnce([]);

            const consoleSpy = vi.spyOn(console, 'log');

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Legacy Fields Ignored',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                // Legacy fields populated but should be ignored
                email_recipients: ['old@example.com'],
                webhook_url: 'https://hooks.example.com/old',
            };

            await processAlertNotification({ data: jobData });

            // Should NOT send email despite legacy field
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('No email recipients configured')
            );
            // Should NOT send webhook despite legacy field
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('No webhook configured')
            );
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should mark notification as complete after successful processing', async () => {
            const { organization, project } = await createTestContext();
            const { alertsService } = await import('../../../modules/alerts/index.js');

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Complete Alert',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            expect(alertsService.markAsNotified).toHaveBeenCalledWith(
                jobData.historyId
            );
        });
    });

    describe('SSRF protection and null historyId', () => {
        it('should block webhook to private IP addresses', async () => {
            const { organization, project } = await createTestContext();
            const { alertsService } = await import('../../../modules/alerts/index.js');

            // Mock notification channel with webhook pointing to loopback
            mockGetAlertRuleChannels.mockResolvedValueOnce([{
                id: '00000000-0000-0000-0000-000000000010',
                type: 'webhook',
                enabled: true,
                config: { url: 'http://127.0.0.1/webhook' },
            }]);

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'SSRF Loopback Test',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            // fetch should NOT have been called since the URL is blocked
            expect(mockFetch).not.toHaveBeenCalled();
            // markAsNotified should be called with an error about private addresses
            expect(alertsService.markAsNotified).toHaveBeenCalledWith(
                jobData.historyId,
                expect.stringContaining('private/internal')
            );
        });

        it('should block webhook to link-local addresses', async () => {
            const { organization, project } = await createTestContext();
            const { alertsService } = await import('../../../modules/alerts/index.js');

            // Mock notification channel with webhook pointing to cloud metadata endpoint
            mockGetAlertRuleChannels.mockResolvedValueOnce([{
                id: '00000000-0000-0000-0000-000000000010',
                type: 'webhook',
                enabled: true,
                config: { url: 'http://169.254.169.254/latest/meta-data/' },
            }]);

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'SSRF Link-Local Test',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            // fetch should NOT have been called since the URL is blocked
            expect(mockFetch).not.toHaveBeenCalled();
            // markAsNotified should be called with an error about private addresses
            expect(alertsService.markAsNotified).toHaveBeenCalledWith(
                jobData.historyId,
                expect.stringContaining('private/internal')
            );
        });

        it('should skip markAsNotified when historyId is null', async () => {
            const { organization, project } = await createTestContext();
            const { alertsService } = await import('../../../modules/alerts/index.js');

            const jobData: AlertNotificationData = {
                historyId: null as any,
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Null HistoryId Alert',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            expect(alertsService.markAsNotified).not.toHaveBeenCalled();
        });

        it('should still call markAsNotified when historyId is present', async () => {
            const { organization, project } = await createTestContext();
            const { alertsService } = await import('../../../modules/alerts/index.js');

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Valid HistoryId Alert',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            expect(alertsService.markAsNotified).toHaveBeenCalledWith(
                jobData.historyId
            );
        });

        it('should include HTTP status code in webhook error', async () => {
            const { organization, project } = await createTestContext();
            const { alertsService } = await import('../../../modules/alerts/index.js');

            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 503,
                statusText: '',
                text: () => Promise.resolve('Service Unavailable'),
            });

            // Mock notification channel with webhook
            mockGetAlertRuleChannels.mockResolvedValueOnce([{
                id: '00000000-0000-0000-0000-000000000010',
                type: 'webhook',
                enabled: true,
                config: { url: 'https://hooks.example.com/failing-503' },
            }]);

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'HTTP Status Code Test',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            // markAsNotified should be called with an error containing the 503 status
            expect(alertsService.markAsNotified).toHaveBeenCalledWith(
                jobData.historyId,
                expect.stringContaining('503')
            );
        });
    });

    describe('beforeWebhookDispatch hook (legacy alert webhook)', () => {
        it('hook receives ruleId and org; mutation reaches the outbound request', async () => {
            const { organization, project } = await createTestContext();

            mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => '' });

            mockGetAlertRuleChannels.mockResolvedValueOnce([{
                id: '00000000-0000-0000-0000-000000000010',
                type: 'webhook',
                enabled: true,
                config: { url: 'https://example.com/legacy-hook' },
            }]);

            let seen: any = null;
            hooks.register('beforeWebhookDispatch', async (ctx) => {
                seen = {
                    ruleId: ctx.ruleId,
                    organizationId: ctx.organizationId,
                    targetHost: ctx.targetHost,
                    channelId: ctx.channelId,
                };
                ctx.headers['X-Injected'] = 'yes';
            });

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Hook Test Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            await processAlertNotification({ data: jobData });

            expect(seen).not.toBeNull();
            expect(seen.targetHost).toBe('example.com');
            expect(seen.ruleId).toBeTruthy();
            expect(seen.organizationId).toBe(organization.id);
            expect(seen.channelId).toBeUndefined();
            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [, init] = mockFetch.mock.calls[0];
            expect(init.headers['X-Injected']).toBe('yes');
        });

        it('rejection blocks the legacy webhook delivery: no HTTP call', async () => {
            const { organization, project } = await createTestContext();
            const { alertsService } = await import('../../../modules/alerts/index.js');

            mockGetAlertRuleChannels.mockResolvedValueOnce([{
                id: '00000000-0000-0000-0000-000000000010',
                type: 'webhook',
                enabled: true,
                config: { url: 'https://example.com/legacy-hook' },
            }]);

            hooks.register('beforeWebhookDispatch', async () => {
                throw new HookRejectionError('policy.webhook_blocked', 'blocked');
            });

            const jobData: AlertNotificationData = {
                historyId: '00000000-0000-0000-0000-000000000001',
                rule_id: '00000000-0000-0000-0000-000000000002',
                rule_name: 'Hook Rejection Test Rule',
                organization_id: organization.id,
                project_id: project.id,
                log_count: 100,
                threshold: 50,
                time_window: 5,
                email_recipients: [],
                webhook_url: undefined,
            };

            // processAlertNotification swallows webhook errors into the errors array
            // and calls markAsNotified with the error message; it does not rethrow.
            await processAlertNotification({ data: jobData });

            expect(mockFetch).not.toHaveBeenCalled();
            expect(alertsService.markAsNotified).toHaveBeenCalledWith(
                jobData.historyId,
                expect.stringContaining('blocked')
            );
        });
    });
});
