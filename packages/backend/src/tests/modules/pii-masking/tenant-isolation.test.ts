/**
 * Tenant isolation tests for PII masking service
 * Verifies that updateRule pre-read SELECT is scoped by organization_id
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../database/index.js';
import { PiiMaskingService } from '../../../modules/pii-masking/service.js';
import { createTestContext } from '../../helpers/factories.js';

const service = new PiiMaskingService();

describe('PiiMaskingService - tenant isolation', () => {
  beforeEach(async () => {
    await db.deleteFrom('pii_masking_rules').execute();
  });

  it('updateRule: pre-read SELECT is scoped by org - cannot validate pattern from another org', async () => {
    const ctxA = await createTestContext();
    const ctxB = await createTestContext();

    // Insert a custom rule in org A
    const ruleOrgA = await db
      .insertInto('pii_masking_rules')
      .values({
        organization_id: ctxA.organization.id,
        project_id: null,
        name: 'org-a-rule',
        display_name: 'Org A Rule',
        pattern_type: 'custom',
        regex_pattern: '\\d{4}',
        field_names: [],
        action: 'mask',
        enabled: true,
        priority: 100,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Org B tries to update org A's rule - should throw (not found)
    await expect(
      service.updateRule(ruleOrgA.id, ctxB.organization.id, { enabled: false })
    ).rejects.toThrow();

    // Org A can update its own rule
    const updated = await service.updateRule(ruleOrgA.id, ctxA.organization.id, { enabled: false });
    expect(updated.enabled).toBe(false);
    expect(updated.organizationId).toBe(ctxA.organization.id);
  });

  it('updateRule: regexPattern validation SELECT is scoped by org - no cross-org data leakage', async () => {
    const ctxA = await createTestContext();
    const ctxB = await createTestContext();

    // Insert a custom rule in org A with a known pattern_type
    const ruleOrgA = await db
      .insertInto('pii_masking_rules')
      .values({
        organization_id: ctxA.organization.id,
        project_id: null,
        name: 'org-a-custom-rule',
        display_name: 'Org A Custom',
        pattern_type: 'custom',
        regex_pattern: '\\d+',
        field_names: [],
        action: 'mask',
        enabled: true,
        priority: 50,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Org B attempts to update with a new regex - SELECT for pattern_type is org-scoped,
    // so the existing row returns undefined (null), and no regex validation runs for org B
    // The subsequent UPDATE also has org_id scope, so it fails cleanly
    await expect(
      service.updateRule(ruleOrgA.id, ctxB.organization.id, { regexPattern: '\\w+' })
    ).rejects.toThrow();
  });
});
