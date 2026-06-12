import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { db } from '../../../database/index.js';
import { alertsRoutes } from '../../../modules/alerts/routes.js';
import { auditLogService } from '../../../modules/audit-log/index.js';
import { createTestContext } from '../../helpers/factories.js';
import crypto from 'crypto';

async function createTestSession(userId: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db
    .insertInto('sessions')
    .values({
      user_id: userId,
      token,
      expires_at: expiresAt,
    })
    .execute();

  return { token, expiresAt };
}

describe('Alert CRUD audit logging', () => {
  let app: FastifyInstance;
  let authToken: string;
  let testOrganization: any;
  let testProject: any;

  beforeAll(async () => {
    app = Fastify();
    await app.register(alertsRoutes, { prefix: '/api/v1/alerts' });
    await app.ready();
    auditLogService.start();
  });

  afterAll(async () => {
    await auditLogService.shutdown();
    await app.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('audit_log').execute();
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

    const context = await createTestContext();
    testOrganization = context.organization;
    testProject = context.project;

    const session = await createTestSession(context.user.id);
    authToken = session.token;
  });

  it('logs an entry when an alert rule is created', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/alerts',
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        organizationId: testOrganization.id,
        projectId: testProject.id,
        name: 'Test Alert',
        threshold: 5,
        timeWindow: 60,
        level: ['error'],
        emailRecipients: ['test@example.com'],
      },
    });

    // Wait for the audit log buffer to flush (interval: 1000ms)
    await new Promise(r => setTimeout(r, 1500));

    const entries = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('organization_id', '=', testOrganization.id)
      .where('action', '=', 'rule.created')
      .execute();

    expect(entries.length).toBeGreaterThan(0);
  });

  it('logs an entry when an alert rule is updated', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/alerts',
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        organizationId: testOrganization.id,
        projectId: testProject.id,
        name: 'Update Me',
        threshold: 5,
        timeWindow: 60,
        level: ['error'],
        emailRecipients: ['test@example.com'],
      },
    });
    const ruleId = createRes.json().alertRule.id;

    // Clear audit log created by POST so we only see the update entry
    await db.deleteFrom('audit_log').execute();

    await app.inject({
      method: 'PUT',
      url: `/api/v1/alerts/${ruleId}?organizationId=${testOrganization.id}`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        name: 'Updated Alert',
        emailRecipients: ['test@example.com'],
      },
    });

    // Wait for the audit log buffer to flush (interval: 1000ms)
    await new Promise(r => setTimeout(r, 1500));

    const entries = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('organization_id', '=', testOrganization.id)
      .where('action', '=', 'rule.updated')
      .execute();

    expect(entries.length).toBeGreaterThan(0);
  });

  it('logs an entry when an alert rule is deleted', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/alerts',
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        organizationId: testOrganization.id,
        projectId: testProject.id,
        name: 'Delete Me',
        threshold: 5,
        timeWindow: 60,
        level: ['error'],
        emailRecipients: ['test@example.com'],
      },
    });
    const ruleId = createRes.json().alertRule.id;

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/alerts/${ruleId}?organizationId=${testOrganization.id}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    // Wait for the audit log buffer to flush (interval: 1000ms)
    await new Promise(r => setTimeout(r, 1500));

    const entries = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('organization_id', '=', testOrganization.id)
      .where('action', '=', 'rule.deleted')
      .execute();

    expect(entries.length).toBeGreaterThan(0);
  });
});
