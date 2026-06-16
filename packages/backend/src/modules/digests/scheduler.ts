/**
 * Digest Scheduler
 *
 * Reads all active digest configs from the database and registers them as
 * repeating cron jobs via the queue abstraction. Called once at worker startup.
 *
 * Both BullMQ (Redis) and graphile-worker (PostgreSQL) backends are supported
 * through the ICronRegistry interface — this service never knows which is active.
 */

import { db } from '../../database/connection.js';
import { getCronRegistry } from '../../queue/queue-factory.js';
import { hub } from '@logtide/core';
import type { CronJobDefinition } from '../../queue/abstractions/types.js';

export interface DigestJobPayload {
  organizationId: string;
  digestConfigId: string;
  frequency: 'daily' | 'weekly';
}

export class DigestScheduler {
  /**
   * Register all active digest configs as repeating cron jobs.
   */
  async registerAllDigests(): Promise<void> {
    const configs = await db
      .selectFrom('digest_configs')
      .select(['id', 'organization_id', 'frequency', 'delivery_hour', 'delivery_day_of_week'])
      .where('enabled', '=', true)
      .execute();

    if (configs.length === 0) {
      hub.captureLog('info', '[DigestScheduler] No active digest configs found');
      return;
    }

    const items: CronJobDefinition[] = configs.map((config) => ({
      task: 'digest-generation',
      cronExpression: this.buildCronExpression(
        config.frequency as 'daily' | 'weekly',
        config.delivery_hour,
        config.delivery_day_of_week
      ),
      payload: {
        organizationId: config.organization_id,
        digestConfigId: config.id,
        frequency: config.frequency,
      } satisfies DigestJobPayload,
      // Stable identifier per org — prevents duplicate schedules on restart
      identifier: `digest:${config.organization_id}`,
    }));

    await getCronRegistry('digest-generation').registerCronJobs(items);
    hub.captureLog('info', `[DigestScheduler] Registered ${items.length} digest schedule(s)`);
  }

  /**
   * Build a standard 5-field cron expression from a digest config.
   *
   * Daily:  "0 8 * * *"   — every day at delivery_hour 
   * Weekly: "0 8 * * 1"   — every week on delivery_day_of_week
   */
  private buildCronExpression(
    frequency: 'daily' | 'weekly',
    deliveryHour: number,
    deliveryDayOfWeek: number | null
  ): string {
    if (frequency === 'daily') {
      return `0 ${deliveryHour} * * *`;
    }
    // Weekly — delivery_day_of_week is guaranteed non-null by the DB constraint
    return `0 ${deliveryHour} * * ${deliveryDayOfWeek}`;
  }
}

export const digestScheduler = new DigestScheduler();
