import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';
import { build } from '../../../server.js';
import { truncateAllTables } from '../../helpers/index.js';
import { createTestUser } from '../../helpers/factories.js';
import { db } from '../../../database/index.js';

describe('auth audit records', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAllTables();
    // audit_log is not in truncateAllTables; clear it separately
    await db.deleteFrom('audit_log').execute();
  });

  it('successful local login produces auth.login_succeeded row', async () => {
    const user = await createTestUser({ email: 'login-audit@example.com', password: 'password123' });

    const res = await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: 'login-audit@example.com', password: 'password123' })
      .expect(200);

    expect(res.body.session.token).toBeDefined();

    // Give the non-buffered record() call time to land (it is awaited inline, so
    // by the time the HTTP response is sent the INSERT is complete)
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'auth.login_succeeded')
      .execute();

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.actor_type).toBe('user');
    expect(row.actor_id).toBe(user.id);
    expect(row.outcome).toBe('success');
    expect((row.metadata as any)?.method).toBe('local');
  });

  it('failed local login (wrong password) produces auth.login_failed row', async () => {
    await createTestUser({ email: 'fail-audit@example.com', password: 'correctpass' });

    await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: 'fail-audit@example.com', password: 'wrongpass' })
      .expect(401);

    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'auth.login_failed')
      .execute();

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.outcome).toBe('failure');
    expect(row.actor_id).toBeNull();
    expect(row.user_email).toBe('fail-audit@example.com');
    expect((row.metadata as any)?.method).toBe('local');
  });

  it('zod-invalid login payload produces NO auth.login_failed row', async () => {
    // missing password field entirely - zod parse fails
    await request(app.server)
      .post('/api/v1/auth/login')
      .send({ email: 'someone@example.com' })
      .expect(400);

    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'auth.login_failed')
      .execute();

    expect(rows).toHaveLength(0);
  });
});
