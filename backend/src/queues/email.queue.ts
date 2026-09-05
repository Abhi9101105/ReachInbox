import { Queue, JobsOptions } from 'bullmq';
import { redisConnection } from '../config/redis';

export const EMAIL_QUEUE_NAME = 'email-queue';

export interface EmailJobData {
  emailId?: string;
  testId?: string;
  message?: string;
  [key: string]: unknown;
}

export type QueueJobCounts = Record<string, number>;

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: {
      count: 1000,
    },
    removeOnFail: {
      count: 5000,
    },
  },
});

export async function addEmailJob(
  jobName: string,
  data: EmailJobData,
  opts?: JobsOptions
) {
  return emailQueue.add(jobName, data, opts);
}

export async function scheduleEmailJob(
  emailId: string,
  opts?: JobsOptions
) {
  return emailQueue.add(
    'send-email',
    { emailId },
    {
      jobId: `email-${emailId}`, // Enforce unique BullMQ job ID per email
      ...opts,
    }
  );
}

export async function getQueueJobCounts(): Promise<QueueJobCounts> {
  return emailQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
}

export async function closeEmailQueue(): Promise<void> {
  try {
    await Promise.race([
      emailQueue.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Email queue close timed out')), 500)
      ),
    ]);
  } catch (err) {
    console.warn('Email queue close error/timeout:', err);
  }
}
