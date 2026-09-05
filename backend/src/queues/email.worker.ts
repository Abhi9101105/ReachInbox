import { Worker, Job, DelayedError } from 'bullmq';
import { EMAIL_QUEUE_NAME, EmailJobData, scheduleEmailJob } from './email.queue';
import { redisConnection } from '../config/redis';
import { config } from '../config/env';
import { prisma } from '../config/prisma';
import { emailService } from '../services/email.service';
import { rateLimiterService } from '../services/rate-limiter.service';
import { elasticsearchService } from '../services/elasticsearch.service';
import { slackService } from '../services/slack.service';

let worker: Worker<EmailJobData> | null = null;

/**
 * Custom error class to signal that a job was rate-limited and rescheduled.
 * The worker should NOT count this as a permanent failure.
 */
class RateLimitDeferralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitDeferralError';
  }
}

export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { emailId, testId, message } = job.data;

  // 1. Handle real email delivery job
  if (emailId) {
    console.log(`[Worker] Processing email job ${job.id} for emailId: ${emailId}`);

    // Fetch email record from PostgreSQL
    const email = await prisma.email.findUnique({
      where: { id: emailId },
    });

    if (!email) {
      console.warn(`[Worker] Email record ${emailId} not found in database. Skipping job.`);
      return;
    }

    // Idempotency check: do not resend if already marked SENT
    if (email.status === 'SENT') {
      console.log(`[Worker] Email ${emailId} is already marked SENT. Skipping duplicate send.`);
      return;
    }

    // Atomic status transition to PROCESSING
    const transitionResult = await prisma.email.updateMany({
      where: {
        id: emailId,
        status: { in: ['SCHEDULED', 'FAILED'] },
      },
      data: {
        status: 'PROCESSING',
        errorMessage: null,
        attemptCount: { increment: 1 },
      },
    });

    if (transitionResult.count === 0) {
      // Re-fetch to verify if another worker marked it SENT or PROCESSING
      const currentEmail = await prisma.email.findUnique({ where: { id: emailId } });
      if (currentEmail?.status === 'SENT') {
        console.log(`[Worker] Email ${emailId} was marked SENT by another execution. Skipping.`);
        return;
      }
      if (currentEmail?.status === 'PROCESSING') {
        console.log(`[Worker] Email ${emailId} is already PROCESSING by another worker. Skipping.`);
        return;
      }
    }

    // --- Phase 4: Rate Limit Check ---
    const rateLimitResult = await rateLimiterService.checkRateLimit('global');

    if (!rateLimitResult.allowed) {
      // Rate limit exhausted: defer this email
      const delayMs = rateLimitResult.retryAfterMs;

      console.log(
        `[Worker] Rate limit exhausted for email ${emailId} ` +
        `(${rateLimitResult.currentCount}/${rateLimitResult.limit} in window ${rateLimitResult.windowKey}). ` +
        `Deferring for ${delayMs}ms.`
      );

      // Trigger Slack rate-limit notification (atomic Redis deduplication, non-blocking)
      slackService.notifyRateLimitReached({
        userId: email.userId,
        senderEmail: email.senderEmail,
        limit: rateLimitResult.limit,
        windowSeconds: config.rateLimit.rateLimitWindowSeconds,
        windowKey: rateLimitResult.windowKey,
      }).catch((err) => {
        console.warn(`[Slack] Rate-limit notification dispatch error on email ${emailId}:`, (err as Error).message);
      });

      // Revert DB status to SCHEDULED and increment deferral counter
      const deferredEmail = await prisma.email.update({
        where: { id: emailId },
        data: {
          status: 'SCHEDULED',
          rateLimitDeferrals: { increment: 1 },
          errorMessage: `Rate limited: deferred until next window (${rateLimitResult.currentCount}/${rateLimitResult.limit})`,
        },
      });

      elasticsearchService.indexEmail(deferredEmail).catch((err) =>
        console.warn(`[Elasticsearch] Sync rate-limit deferral index error on email ${emailId}:`, err.message)
      );

      // Reschedule via BullMQ: move the active job to delayed state
      // job.token is the lock token held by this worker for this job
      if (job.token) {
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        // Throw DelayedError to signal BullMQ that the job was intentionally
        // moved back to delayed; this prevents BullMQ from marking it as
        // completed or failed.
        throw new DelayedError('Rate limited – deferred to next window');
      } else {
        // Fallback: remove the old job and re-queue with delay.
        // This can happen when processEmailJob is called directly in tests.
        try {
          await scheduleEmailJob(emailId, { delay: delayMs });
        } catch {
          // Job ID might already exist; that's fine – the job is already queued
        }
        throw new RateLimitDeferralError('Rate limited – rescheduled');
      }
    }

    // --- Phase 4: Minimum Send Delay Check ---
    const minDelayResult = await rateLimiterService.checkMinDelay();

    if (!minDelayResult.allowed) {
      const waitMs = minDelayResult.waitMs;
      console.log(
        `[Worker] Min send delay not met for email ${emailId}. ` +
        `Need to wait ${waitMs}ms. Deferring.`
      );

      // Revert DB status to SCHEDULED
      const minDelayEmail = await prisma.email.update({
        where: { id: emailId },
        data: {
          status: 'SCHEDULED',
          errorMessage: null,
        },
      });

      elasticsearchService.indexEmail(minDelayEmail).catch((err) =>
        console.warn(`[Elasticsearch] Sync min-delay deferral index error on email ${emailId}:`, err.message)
      );

      if (job.token) {
        await job.moveToDelayed(Date.now() + waitMs, job.token);
        throw new DelayedError('Min send delay – deferred');
      } else {
        try {
          await scheduleEmailJob(emailId, { delay: waitMs });
        } catch {
          // fallback
        }
        throw new RateLimitDeferralError('Min delay – rescheduled');
      }
    }

    // --- Send email via Nodemailer Ethereal transport ---
    try {
      const result = await emailService.sendEmail({
        from: email.senderEmail,
        to: email.recipient,
        subject: email.subject,
        text: email.body,
      });

      // Update database record to SENT
      const sentEmail = await prisma.email.update({
        where: { id: emailId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: result.messageId,
          previewUrl: typeof result.previewUrl === 'string' ? result.previewUrl : null,
          errorMessage: null,
        },
      });

      elasticsearchService.indexEmail(sentEmail).catch((err) =>
        console.warn(`[Elasticsearch] Sync sent index error on email ${emailId}:`, err.message)
      );

      console.log(
        `[Worker] Email ${emailId} successfully sent to ${email.recipient}. MessageId: ${result.messageId}`
      );
      if (result.previewUrl) {
        console.log(`[Worker] Ethereal Preview URL: ${result.previewUrl}`);
      }
    } catch (error) {
      const err = error as Error;
      console.error(`[Worker] Failed to deliver email ${emailId} to ${email.recipient}: ${err.message}`);

      // Persist failure status and error details to database
      const failedEmail = await prisma.email.update({
        where: { id: emailId },
        data: {
          status: 'FAILED',
          errorMessage: err.message || 'SMTP delivery failed',
        },
      });

      elasticsearchService.indexEmail(failedEmail).catch((esErr) =>
        console.warn(`[Elasticsearch] Sync failure index error on email ${emailId}:`, esErr.message)
      );

      // Re-throw so BullMQ handles job failure and retry policy
      throw error;
    }
    return;
  }

  // 2. Handle Phase 2 test job
  if (testId || message) {
    console.log(`Processing test job ${job.id} (testId: ${testId}, message: "${message}")`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    console.log(`Test job ${job.id} processed successfully`);
    return;
  }

  console.warn(`[Worker] Unrecognized job payload on job ${job.id}:`, job.data);
}

export function initEmailWorker(): Worker<EmailJobData> {
  if (worker) {
    return worker;
  }

  worker = new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>) => {
      await processEmailJob(job);
    },
    {
      connection: redisConnection,
      concurrency: config.workerConcurrency,
    }
  );

  worker.on('completed', (job: Job<EmailJobData>) => {
    console.log(`Job completed: ${job.id} (name: ${job.name})`);
  });

  worker.on('failed', (job: Job<EmailJobData> | undefined, err: Error) => {
    // Suppress noisy logs for intentional rate-limit deferrals
    if (err instanceof RateLimitDeferralError) {
      return;
    }
    // DelayedError is BullMQ's internal signal – not a real failure
    if (err.message?.includes('Rate limited') || err.message?.includes('Min send delay')) {
      return;
    }
    console.error(`Job failed: ${job?.id} with error: ${err.message}`);
  });

  worker.on('error', (err: Error) => {
    if (worker === null) {
      return;
    }
    console.error(`Worker error on queue ${EMAIL_QUEUE_NAME}:`, err);
  });

  console.log(
    `Email worker initialized | concurrency=${config.workerConcurrency} ` +
    `| hourlyLimit=${config.rateLimit.emailHourlyLimit} ` +
    `| minDelayMs=${config.rateLimit.minSendDelayMs} ` +
    `| windowSeconds=${config.rateLimit.rateLimitWindowSeconds}`
  );
  return worker;
}

export async function closeEmailWorker(): Promise<void> {
  if (!worker) {
    return;
  }

  const workerToClose = worker;
  worker = null;

  try {
    await Promise.race([
      workerToClose.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Worker close timed out')), 1000)
      ),
    ]);
    console.log('Email worker closed.');
  } catch {
    try {
      await workerToClose.close(true);
    } catch {
      // ignore
    }
  }
}
