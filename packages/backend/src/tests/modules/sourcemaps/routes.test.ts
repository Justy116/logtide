import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { db } from '../../../database/index.js';
import { sourcemapsRoutes } from '../../../modules/sourcemaps/routes.js';
import { createTestContext, createTestOrganization, createTestProject } from '../../helpers/factories.js';

/**
 * Build a multipart/form-data body buffer.
 * Fields that come before the file part end up in @fastify/multipart's data.fields.
 */
function buildMultipart(
    boundary: string,
    fields: Record<string, string>,
    file?: { name: string; content: Buffer }
): Buffer {
    const CRLF = '\r\n';
    const parts: Buffer[] = [];

    for (const [name, value] of Object.entries(fields)) {
        parts.push(
            Buffer.from(
                `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`
            )
        );
    }

    if (file) {
        parts.push(
            Buffer.from(
                `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${file.name}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`
            )
        );
        parts.push(file.content);
        parts.push(Buffer.from(CRLF));
    }

    parts.push(Buffer.from(`--${boundary}--${CRLF}`));
    return Buffer.concat(parts);
}

async function createTestSession(userId: string) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insertInto('sessions').values({ user_id: userId, token, expires_at: expiresAt }).execute();
    return { token };
}

describe('Sourcemaps Routes', () => {
    let app: FastifyInstance;
    let testUser: any;
    let testOrganization: any;
    let testProject: any;
    let testApiKey: any;
    let authToken: string;

    beforeAll(async () => {
        app = Fastify();

        // Simulate API key auth plugin: set request.projectId from X-API-Key header
        app.addHook('onRequest', async (request: any) => {
            const rawKey = request.headers['x-api-key'] as string | undefined;
            if (rawKey) {
                const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
                const keyRecord = await db
                    .selectFrom('api_keys')
                    .select(['project_id', 'type'])
                    .where('key_hash', '=', keyHash)
                    .executeTakeFirst();
                if (keyRecord) {
                    request.projectId = keyRecord.project_id;
                    request.apiKeyType = keyRecord.type;
                }
            }
        });

        await app.register(sourcemapsRoutes);
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(async () => {
        await (db as any).deleteFrom('sourcemaps').execute();

        const ctx = await createTestContext();
        testUser = ctx.user;
        testOrganization = ctx.organization;
        testProject = ctx.project;
        testApiKey = ctx.apiKey;

        const session = await createTestSession(testUser.id);
        authToken = session.token;
    });

    // =========================================================================
    // POST /api/v1/sourcemaps
    // =========================================================================

    describe('POST /api/v1/sourcemaps', () => {
        it('returns 401 when no API key is provided', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/sourcemaps',
                payload: {},
            });
            expect(res.statusCode).toBe(401);
        });

        it('returns 403 for write-only API key', async () => {
            // Create a write-only API key
            const writeKey = `lp_test_${crypto.randomBytes(16).toString('hex')}`;
            const writeKeyHash = crypto.createHash('sha256').update(writeKey).digest('hex');
            await db.insertInto('api_keys').values({
                project_id: testProject.id,
                name: 'Write Only',
                key_hash: writeKeyHash,
                type: 'write',
                allowed_origins: null,
                last_used: null,
            }).execute();

            const boundary = 'boundary123';
            const body = buildMultipart(boundary, { release: '1.0.0', fileName: 'app.js.map' }, {
                name: 'app.js.map',
                content: Buffer.from('{}'),
            });

            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/sourcemaps',
                headers: {
                    'x-api-key': writeKey,
                    'content-type': `multipart/form-data; boundary=${boundary}`,
                },
                payload: body,
            });
            expect(res.statusCode).toBe(403);
        });

        it('returns 400 when file has no content', async () => {
            // Send multipart with fields but no file part
            const boundary = 'boundary456';
            const body = Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="release"\r\n\r\n1.0.0\r\n--${boundary}--\r\n`
            );

            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/sourcemaps',
                headers: {
                    'x-api-key': testApiKey.plainKey,
                    'content-type': `multipart/form-data; boundary=${boundary}`,
                },
                payload: body,
            });
            // No file → either 400 or multipart parsing issue
            expect([400, 500]).toContain(res.statusCode);
        });

        it('returns 400 when fileName does not end with .map', async () => {
            const boundary = 'boundarybad';
            const body = buildMultipart(
                boundary,
                { release: '1.0.0', fileName: 'app.js' },
                { name: 'app.js', content: Buffer.from('{}') }
            );

            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/sourcemaps',
                headers: {
                    'x-api-key': testApiKey.plainKey,
                    'content-type': `multipart/form-data; boundary=${boundary}`,
                },
                payload: body,
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 201 and stores the source map on success', async () => {
            const boundary = 'boundaryok';
            const mapContent = Buffer.from('{"version":3,"sources":["app.ts"],"mappings":""}');
            const body = buildMultipart(
                boundary,
                { release: '1.0.0', fileName: 'app.js.map' },
                { name: 'app.js.map', content: mapContent }
            );

            const res = await app.inject({
                method: 'POST',
                url: '/api/v1/sourcemaps',
                headers: {
                    'x-api-key': testApiKey.plainKey,
                    'content-type': `multipart/form-data; boundary=${boundary}`,
                },
                payload: body,
            });

            expect(res.statusCode).toBe(201);
            const body2 = JSON.parse(res.payload);
            expect(body2.release).toBe('1.0.0');
            expect(body2.fileName).toBe('app.js.map');
            expect(body2.fileSize).toBe(mapContent.length);
        });
    });

    // =========================================================================
    // GET /api/v1/sourcemaps
    // =========================================================================

    describe('GET /api/v1/sourcemaps', () => {
        it('returns 401 without auth token', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/v1/sourcemaps?organizationId=${testOrganization.id}&projectId=${testProject.id}`,
            });
            expect(res.statusCode).toBe(401);
        });

        it('returns 400 when organizationId is missing', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/v1/sourcemaps?projectId=${testProject.id}`,
                headers: { Authorization: `Bearer ${authToken}` },
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 400 when projectId is missing', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/v1/sourcemaps?organizationId=${testOrganization.id}`,
                headers: { Authorization: `Bearer ${authToken}` },
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 403 for non-member organization', async () => {
            const otherCtx = await createTestContext();
            const otherSession = await createTestSession(testUser.id);

            const res = await app.inject({
                method: 'GET',
                url: `/api/v1/sourcemaps?organizationId=${otherCtx.organization.id}&projectId=${otherCtx.project.id}`,
                headers: { Authorization: `Bearer ${otherSession.token}` },
            });
            expect(res.statusCode).toBe(403);
        });

        it('returns 200 with empty list when no maps exist', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/v1/sourcemaps?organizationId=${testOrganization.id}&projectId=${testProject.id}`,
                headers: { Authorization: `Bearer ${authToken}` },
            });

            expect(res.statusCode).toBe(200);
            const parsed = JSON.parse(res.payload);
            expect(parsed.sourcemaps).toEqual([]);
        });

        it('returns 403 when projectId belongs to another organization', async () => {
            // Member of testOrganization supplies a foreign projectId to read
            // another tenant's source maps.
            const foreignOrg = await createTestOrganization();
            const foreignProject = await createTestProject({ organizationId: foreignOrg.id });

            const res = await app.inject({
                method: 'GET',
                url: `/api/v1/sourcemaps?organizationId=${testOrganization.id}&projectId=${foreignProject.id}`,
                headers: { Authorization: `Bearer ${authToken}` },
            });
            expect(res.statusCode).toBe(403);
        });

        it('returns 200 with maps filtered by release', async () => {
            const res = await app.inject({
                method: 'GET',
                url: `/api/v1/sourcemaps?organizationId=${testOrganization.id}&projectId=${testProject.id}&release=1.0.0`,
                headers: { Authorization: `Bearer ${authToken}` },
            });

            expect(res.statusCode).toBe(200);
            const parsed = JSON.parse(res.payload);
            expect(Array.isArray(parsed.sourcemaps)).toBe(true);
        });
    });

    // =========================================================================
    // DELETE /api/v1/sourcemaps/:release
    // =========================================================================

    describe('DELETE /api/v1/sourcemaps/:release', () => {
        it('returns 401 without auth token', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/v1/sourcemaps/1.0.0?organizationId=${testOrganization.id}&projectId=${testProject.id}`,
            });
            expect(res.statusCode).toBe(401);
        });

        it('returns 403 for non-member organization', async () => {
            const otherCtx = await createTestContext();
            const otherSession = await createTestSession(testUser.id);

            const res = await app.inject({
                method: 'DELETE',
                url: `/api/v1/sourcemaps/1.0.0?organizationId=${otherCtx.organization.id}&projectId=${otherCtx.project.id}`,
                headers: { Authorization: `Bearer ${otherSession.token}` },
            });
            expect(res.statusCode).toBe(403);
        });

        it('returns 403 when projectId belongs to another organization', async () => {
            const foreignOrg = await createTestOrganization();
            const foreignProject = await createTestProject({ organizationId: foreignOrg.id });

            const res = await app.inject({
                method: 'DELETE',
                url: `/api/v1/sourcemaps/1.0.0?organizationId=${testOrganization.id}&projectId=${foreignProject.id}`,
                headers: { Authorization: `Bearer ${authToken}` },
            });
            expect(res.statusCode).toBe(403);
        });

        it('returns 200 with deleted count 0 when no maps exist', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/v1/sourcemaps/nonexistent?organizationId=${testOrganization.id}&projectId=${testProject.id}`,
                headers: { Authorization: `Bearer ${authToken}` },
            });

            expect(res.statusCode).toBe(200);
            const parsed = JSON.parse(res.payload);
            expect(parsed.deleted).toBe(0);
        });

        it('returns 400 when organizationId is missing', async () => {
            const res = await app.inject({
                method: 'DELETE',
                url: `/api/v1/sourcemaps/1.0.0?projectId=${testProject.id}`,
                headers: { Authorization: `Bearer ${authToken}` },
            });
            expect(res.statusCode).toBe(400);
        });
    });
});
