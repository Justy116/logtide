/**
 * Tenant isolation tests for Exception service
 * Verifies that getExceptionByLogId, getExceptionById, and updateErrorGroupStatus
 * are scoped by organization_id
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { ExceptionService } from '../../../modules/exceptions/service.js';
import { createTestContext, createTestLog } from '../../helpers/factories.js';
import type { CreateExceptionParams } from '../../../modules/exceptions/types.js';

const service = new ExceptionService(db);

describe('ExceptionService - tenant isolation', () => {
  beforeEach(async () => {
    await db.deleteFrom('stack_frames').execute();
    await db.deleteFrom('exceptions').execute();
    await db.deleteFrom('error_groups').execute();
  });

  it('getExceptionByLogId: returns null when org does not match', async () => {
    const ctxA = await createTestContext();
    const ctxB = await createTestContext();

    const log = await createTestLog({ projectId: ctxA.project.id, level: 'error' });

    const params: CreateExceptionParams = {
      organizationId: ctxA.organization.id,
      projectId: ctxA.project.id,
      logId: log.id,
      fingerprint: 'isolation-test-fp',
      parsedData: {
        exceptionType: 'Error',
        exceptionMessage: 'Isolation test',
        language: 'nodejs',
        rawStackTrace: '',
        frames: [],
      },
    };

    await service.createException(params);

    // Org A can find it
    const foundByA = await service.getExceptionByLogId(log.id, ctxA.organization.id);
    expect(foundByA).not.toBeNull();
    expect(foundByA!.exception.organizationId).toBe(ctxA.organization.id);

    // Org B cannot find it
    const foundByB = await service.getExceptionByLogId(log.id, ctxB.organization.id);
    expect(foundByB).toBeNull();
  });

  it('getExceptionById: returns null when org does not match', async () => {
    const ctxA = await createTestContext();
    const ctxB = await createTestContext();

    const log = await createTestLog({ projectId: ctxA.project.id, level: 'error' });

    const exceptionId = await service.createException({
      organizationId: ctxA.organization.id,
      projectId: ctxA.project.id,
      logId: log.id,
      fingerprint: 'byid-isolation-fp',
      parsedData: {
        exceptionType: 'TypeError',
        exceptionMessage: 'Cannot read x',
        language: 'nodejs',
        rawStackTrace: '',
        frames: [],
      },
    });

    // Org A can retrieve it
    const foundByA = await service.getExceptionById(exceptionId, ctxA.organization.id);
    expect(foundByA).not.toBeNull();

    // Org B cannot retrieve it
    const foundByB = await service.getExceptionById(exceptionId, ctxB.organization.id);
    expect(foundByB).toBeNull();
  });

  it('updateErrorGroupStatus: only updates groups belonging to the given org', async () => {
    const ctxA = await createTestContext();
    const ctxB = await createTestContext();

    // Create an error group for org A
    const groupA = await db
      .insertInto('error_groups')
      .values({
        organization_id: ctxA.organization.id,
        project_id: ctxA.project.id,
        fingerprint: 'isolation-grp-fp',
        exception_type: 'Error',
        exception_message: 'Org A group',
        language: 'nodejs',
        occurrence_count: 1,
        first_seen: new Date(),
        last_seen: new Date(),
        status: 'open',
        sample_log_id: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    // Org B tries to resolve org A's group - should return null (no row matched)
    const resultByB = await service.updateErrorGroupStatus(groupA.id, ctxB.organization.id, 'resolved');
    expect(resultByB).toBeNull();

    // Confirm the group is still open
    const row = await db
      .selectFrom('error_groups')
      .select('status')
      .where('id', '=', groupA.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('open');

    // Org A can update its own group
    const resultByA = await service.updateErrorGroupStatus(groupA.id, ctxA.organization.id, 'resolved');
    expect(resultByA).not.toBeNull();
    expect(resultByA!.status).toBe('resolved');
  });
});
