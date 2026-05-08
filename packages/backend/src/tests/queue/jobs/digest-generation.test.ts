import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IJob } from '../../../queue/abstractions/types.js';
import type { DigestJobPayload } from '../../../modules/digests/generator.js';


vi.mock('../../../modules/digests/generator.js', () => ({
  digestGenerator: {
    generateAndSendDigest: vi.fn(),
  },
}));

import { processDigestGeneration } from '../../../queue/jobs/digest-generation.js';
import { digestGenerator } from '../../../modules/digests/generator.js';

describe('processDigestGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process daily digest job successfully', async () => {
    const job: IJob<DigestJobPayload> = {
      id: 'job_1',
      name: 'digest-generation',
      data: {
        organizationId: 'org_1',
        digestConfigId: 'config_1',
        frequency: 'daily',
      },
    };

    vi.mocked(digestGenerator.generateAndSendDigest).mockResolvedValueOnce(undefined);

    await processDigestGeneration(job);

    expect(digestGenerator.generateAndSendDigest).toHaveBeenCalledTimes(1);
    expect(digestGenerator.generateAndSendDigest).toHaveBeenCalledWith({
      organizationId: 'org_1',
      digestConfigId: 'config_1',
      frequency: 'daily',
    });
  });

  it('should process weekly digest job successfully', async () => {
    const job: IJob<DigestJobPayload> = {
      id: 'job_2',
      name: 'digest-generation',
      data: {
        organizationId: 'org_2',
        digestConfigId: 'config_2',
        frequency: 'weekly',
      },
    };

    vi.mocked(digestGenerator.generateAndSendDigest).mockResolvedValueOnce(undefined);

    await processDigestGeneration(job);

    expect(digestGenerator.generateAndSendDigest).toHaveBeenCalledTimes(1);
    expect(digestGenerator.generateAndSendDigest).toHaveBeenCalledWith({
      organizationId: 'org_2',
      digestConfigId: 'config_2',
      frequency: 'weekly',
    });
  });

  it('should throw error if digest generation fails', async () => {
    const job: IJob<DigestJobPayload> = {
      id: 'job_3',
      name: 'digest-generation',
      data: {
        organizationId: 'org_3',
        digestConfigId: 'config_3',
        frequency: 'daily',
      },
    };

    const error = new Error('SMTP connection failed');
    vi.mocked(digestGenerator.generateAndSendDigest).mockRejectedValueOnce(error);

    await expect(processDigestGeneration(job)).rejects.toThrow('SMTP connection failed');

    expect(digestGenerator.generateAndSendDigest).toHaveBeenCalledTimes(1);
  });

  it('should handle missing job data gracefully', async () => {
    const job: IJob<DigestJobPayload> = {
      id: 'job_4',
      name: 'digest-generation',
      data: {
        organizationId: '',
        digestConfigId: '',
        frequency: 'daily',
      },
    };

    vi.mocked(digestGenerator.generateAndSendDigest).mockResolvedValueOnce(undefined);

    await processDigestGeneration(job);

    expect(digestGenerator.generateAndSendDigest).toHaveBeenCalledTimes(1);
  });
});
