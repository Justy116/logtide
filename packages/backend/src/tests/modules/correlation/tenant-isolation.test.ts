/**
 * Tenant isolation tests for Correlation service
 * Verifies getLogIdentifiers is scoped by project_id
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { CorrelationService } from '../../../modules/correlation/service.js';
import { createTestContext, createTestLog } from '../../helpers/factories.js';

describe('CorrelationService - tenant isolation', () => {
  let service: CorrelationService;

  beforeEach(async () => {
    service = new CorrelationService();
    await db.deleteFrom('log_identifiers').execute();
    await db.deleteFrom('logs').execute();
  });

  it('getLogIdentifiers: only returns identifiers for the given project', async () => {
    const ctxA = await createTestContext();
    const ctxB = await createTestContext();

    const logA = await createTestLog({ projectId: ctxA.project.id });
    const logB = await createTestLog({ projectId: ctxB.project.id });

    // Use the same log_id value but different projects (simulates id-guessing attempt)
    // Insert identifier for org A's log
    await db
      .insertInto('log_identifiers')
      .values({
        log_id: logA.id,
        log_time: logA.time,
        project_id: ctxA.project.id,
        organization_id: ctxA.organization.id,
        identifier_type: 'uuid',
        identifier_value: '11111111-1111-1111-1111-111111111111',
        source_field: 'message',
      })
      .execute();

    // Insert identifier for org B's log
    await db
      .insertInto('log_identifiers')
      .values({
        log_id: logB.id,
        log_time: logB.time,
        project_id: ctxB.project.id,
        organization_id: ctxB.organization.id,
        identifier_type: 'uuid',
        identifier_value: '22222222-2222-2222-2222-222222222222',
        source_field: 'message',
      })
      .execute();

    // Project A can get its own identifiers
    const identsA = await service.getLogIdentifiers(logA.id, ctxA.project.id);
    expect(identsA).toHaveLength(1);
    expect(identsA[0].value).toBe('11111111-1111-1111-1111-111111111111');

    // Project A querying log B's id but with project A's scope returns nothing
    const identsACrossB = await service.getLogIdentifiers(logB.id, ctxA.project.id);
    expect(identsACrossB).toHaveLength(0);

    // Project B gets its own identifiers
    const identsB = await service.getLogIdentifiers(logB.id, ctxB.project.id);
    expect(identsB).toHaveLength(1);
    expect(identsB[0].value).toBe('22222222-2222-2222-2222-222222222222');
  });
});
