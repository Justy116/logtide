/**
 * Digest Generation Job Processor
 *
 * Processes scheduled digest generation jobs triggered by cron.
 */

import type { IJob } from '../abstractions/types.js';
import { digestGenerator } from '../../modules/digests/generator.js';
import type { DigestJobPayload } from '../../modules/digests/scheduler.js';
import { hub } from '@logtide/core';
 
//called by the worker when a scheduled digest cron job fires.
export async function processDigestGeneration(job: IJob<DigestJobPayload>): Promise<void> {
  const { organizationId, digestConfigId, frequency } = job.data;

  hub.captureLog(
    'info',
    `[DigestJob] Processing ${frequency} digest for org ${organizationId} (config: ${digestConfigId})`
  );

  try {
    await digestGenerator.generateAndSendDigest(job.data);
    hub.captureLog('info', `[DigestJob] Successfully completed digest for org ${organizationId}`);
  } catch (error: any) {
    hub.captureLog(
      'error',
      `[DigestJob] Failed to process digest for org ${organizationId}: ${error.message}`,
      { error: { name: error.name, message: error.message, stack: error.stack } }
    );
    throw error; 
  }
}
