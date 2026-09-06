import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { addEmailJob, scheduleEmailJob, getQueueJobCounts } from '../queues/email.queue';
import { prisma } from '../config/prisma';
import { config } from '../config/env';
import { AppError } from '../middleware/error.middleware';
import { rateLimiterService } from '../services/rate-limiter.service';
import { elasticsearchService } from '../services/elasticsearch.service';

/**
 * Helper to ensure a system user exists for foreign key satisfaction
 */
async function getOrCreateDefaultUser(): Promise<string> {
  const defaultEmail = 'system@reachinbox.ai';
  const user = await prisma.user.upsert({
    where: { email: defaultEmail },
    update: {},
    create: {
      email: defaultEmail,
      name: 'System User',
    },
  });
  return user.id;
}

/**
 * POST /api/test/emails
 * Schedule or immediately dispatch a real email via BullMQ & Ethereal SMTP.
 * Supports optional scheduledAt (ISO timestamp) or delayMs for future scheduling.
 */
export async function scheduleTestEmail(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { recipient, subject, body, senderEmail, delayMs, scheduledAt } = req.body;

    // Validate inputs
    if (!recipient || typeof recipient !== 'string' || !recipient.includes('@')) {
      throw new AppError('Field "recipient" is required and must be a valid email address', 400);
    }
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      throw new AppError('Field "subject" is required and must be a non-empty string', 400);
    }
    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      throw new AppError('Field "body" is required and must be a non-empty string', 400);
    }

    // Compute delay: scheduledAt takes priority over delayMs
    let computedDelay = 0;
    let computedScheduledAt: Date;

    if (scheduledAt) {
      const parsed = new Date(scheduledAt);
      if (isNaN(parsed.getTime())) {
        throw new AppError('Field "scheduledAt" must be a valid ISO 8601 timestamp', 400);
      }
      computedDelay = Math.max(0, parsed.getTime() - Date.now());
      computedScheduledAt = parsed;
    } else {
      const parsedDelay = delayMs ? (typeof delayMs === 'number' ? delayMs : parseInt(delayMs, 10)) : 0;
      if (isNaN(parsedDelay) || parsedDelay < 0) {
        throw new AppError('Field "delayMs", if provided, must be a non-negative number', 400);
      }
      computedDelay = parsedDelay;
      computedScheduledAt = new Date(Date.now() + computedDelay);
    }

    const userId = req.user?.id || (await getOrCreateDefaultUser());
    const resolvedSender = senderEmail && typeof senderEmail === 'string' ? senderEmail.trim() : config.ethereal.from;

    // 1. Create Email record in PostgreSQL
    const email = await prisma.email.create({
      data: {
        userId,
        senderEmail: resolvedSender,
        recipient: recipient.trim(),
        subject: subject.trim(),
        body: body.trim(),
        status: 'SCHEDULED',
        scheduledAt: computedScheduledAt,
      },
    });

    // 2. Add BullMQ Job
    const jobOpts = computedDelay > 0 ? { delay: computedDelay } : undefined;
    const job = await scheduleEmailJob(email.id, jobOpts);

    // 3. Asynchronously index into Elasticsearch (resilient: failures do not block API)
    elasticsearchService.indexEmail(email).catch((err) =>
      console.warn(`[Elasticsearch] Async index error on email ${email.id}:`, err.message)
    );

    res.status(201).json({
      success: true,
      emailId: email.id,
      jobId: job.id,
      status: email.status,
      scheduledAt: email.scheduledAt.toISOString(),
      ...(computedDelay > 0 && { delayMs: computedDelay }),
      message: computedDelay > 0 ? `Email scheduled to send in ${computedDelay}ms` : 'Email queued for immediate delivery',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/test/emails/batch
 * Schedule a batch of emails for testing.
 */
export async function scheduleTestEmailBatch(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { emails, scheduledAt, delayMs, senderEmail } = req.body;

    if (!Array.isArray(emails) || emails.length === 0) {
      throw new AppError('Field "emails" must be a non-empty array', 400);
    }

    if (emails.length > 5000) {
      throw new AppError('Batch size must not exceed 5000 emails', 400);
    }

    // Compute delay
    let computedDelay = 0;
    let computedScheduledAt: Date;

    if (scheduledAt) {
      const parsed = new Date(scheduledAt);
      if (isNaN(parsed.getTime())) {
        throw new AppError('Field "scheduledAt" must be a valid ISO 8601 timestamp', 400);
      }
      computedDelay = Math.max(0, parsed.getTime() - Date.now());
      computedScheduledAt = parsed;
    } else {
      const parsedDelay = delayMs ? (typeof delayMs === 'number' ? delayMs : parseInt(delayMs, 10)) : 0;
      if (isNaN(parsedDelay) || parsedDelay < 0) {
        throw new AppError('Field "delayMs", if provided, must be a non-negative number', 400);
      }
      computedDelay = parsedDelay;
      computedScheduledAt = new Date(Date.now() + computedDelay);
    }

    const userId = req.user?.id || (await getOrCreateDefaultUser());
    const resolvedSender = senderEmail && typeof senderEmail === 'string'
      ? senderEmail.trim()
      : config.ethereal.from;

    // Validate each email in batch
    for (let i = 0; i < emails.length; i++) {
      const e = emails[i];
      if (!e.recipient || typeof e.recipient !== 'string' || !e.recipient.includes('@')) {
        throw new AppError(`Email at index ${i}: "recipient" is required and must be a valid email address`, 400);
      }
      if (!e.subject || typeof e.subject !== 'string') {
        throw new AppError(`Email at index ${i}: "subject" is required`, 400);
      }
      if (!e.body || typeof e.body !== 'string') {
        throw new AppError(`Email at index ${i}: "body" is required`, 400);
      }
    }

    // Create all email records in PostgreSQL
    const createdEmails = await prisma.$transaction(
      emails.map((e: { recipient: string; subject: string; body: string; senderEmail?: string }) =>
        prisma.email.create({
          data: {
            userId,
            senderEmail: e.senderEmail?.trim() || resolvedSender,
            recipient: e.recipient.trim(),
            subject: e.subject.trim(),
            body: e.body.trim(),
            status: 'SCHEDULED',
            scheduledAt: computedScheduledAt,
          },
        })
      )
    );

    // Queue all BullMQ jobs
    const jobOpts = computedDelay > 0 ? { delay: computedDelay } : undefined;
    const jobResults = await Promise.all(
      createdEmails.map((email: { id: string }) => scheduleEmailJob(email.id, jobOpts))
    );

    // Asynchronously bulk index into Elasticsearch (resilient)
    elasticsearchService.bulkIndexEmails(createdEmails).catch((err) =>
      console.warn(`[Elasticsearch] Async bulk index error:`, err.message)
    );

    res.status(201).json({
      success: true,
      count: createdEmails.length,
      emailIds: createdEmails.map((e: { id: string }) => e.id),
      jobIds: jobResults.map((j) => j.id),
      scheduledAt: computedScheduledAt.toISOString(),
      ...(computedDelay > 0 && { delayMs: computedDelay }),
      message: `${createdEmails.length} emails queued${computedDelay > 0 ? ` with ${computedDelay}ms delay` : ' for immediate delivery'}`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/test/search/emails
 * Search emails via Elasticsearch index.
 */
export async function searchTestEmails(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const {
      q,
      status,
      recipient,
      senderEmail,
      fromDate,
      toDate,
      page,
      limit,
      sortBy,
      sortOrder,
    } = req.query;

    const result = await elasticsearchService.searchEmails({
      q: typeof q === 'string' ? q : undefined,
      status: typeof status === 'string' ? status : undefined,
      recipient: typeof recipient === 'string' ? recipient : undefined,
      senderEmail: typeof senderEmail === 'string' ? senderEmail : undefined,
      fromDate: typeof fromDate === 'string' ? fromDate : undefined,
      toDate: typeof toDate === 'string' ? toDate : undefined,
      page: page ? parseInt(page as string, 10) : 1,
      limit: limit ? parseInt(limit as string, 10) : 20,
      sortBy: typeof sortBy === 'string' ? (sortBy as any) : 'scheduledAt',
      sortOrder: typeof sortOrder === 'string' ? (sortOrder as any) : 'desc',
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/test/search/reindex
 * Rebuild Elasticsearch index from PostgreSQL database.
 */
export async function reindexTestEmails(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await elasticsearchService.reindexFromDatabase();
    res.status(result.success ? 200 : 207).json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/test/emails/:id
 * Retrieve status, delivery metadata, and Ethereal preview URL of a scheduled/sent email
 */
export async function getTestEmail(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const email = await prisma.email.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    if (!email) {
      throw new AppError(`Email with ID "${id}" not found`, 404);
    }

    res.status(200).json({
      success: true,
      email: {
        id: email.id,
        recipient: email.recipient,
        senderEmail: email.senderEmail,
        subject: email.subject,
        body: email.body,
        status: email.status,
        scheduledAt: email.scheduledAt.toISOString(),
        sentAt: email.sentAt ? email.sentAt.toISOString() : null,
        providerMessageId: email.providerMessageId,
        previewUrl: email.previewUrl,
        errorMessage: email.errorMessage,
        attemptCount: email.attemptCount,
        rateLimitDeferrals: email.rateLimitDeferrals,
        createdAt: email.createdAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/test/rate-limit/status
 * Diagnostic endpoint: show current rate-limit counter.
 */
export async function getRateLimitStatus(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const currentCount = await rateLimiterService.getCurrentCount('global');
    res.status(200).json({
      success: true,
      scope: 'global',
      currentCount,
      limit: config.rateLimit.emailHourlyLimit,
      windowSeconds: config.rateLimit.rateLimitWindowSeconds,
      minSendDelayMs: config.rateLimit.minSendDelayMs,
      workerConcurrency: config.workerConcurrency,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}

export async function createTestJob(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      throw new AppError('Field "message" is required and must be a non-empty string', 400);
    }

    const testId = randomUUID();
    const job = await addEmailJob('test-job', {
      testId,
      message: message.trim(),
    });

    res.status(201).json({
      success: true,
      jobId: job.id,
      testId,
      message: 'Test job queued successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function createDelayedJob(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { message, delayMs } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      throw new AppError('Field "message" is required and must be a non-empty string', 400);
    }

    const parsedDelay = typeof delayMs === 'number' ? delayMs : parseInt(delayMs, 10);
    if (isNaN(parsedDelay) || parsedDelay <= 0) {
      throw new AppError('Field "delayMs" must be a positive number', 400);
    }

    const testId = randomUUID();
    const job = await addEmailJob(
      'delayed-test-job',
      {
        testId,
        message: message.trim(),
      },
      {
        delay: parsedDelay,
      }
    );

    const scheduledFor = new Date(Date.now() + parsedDelay).toISOString();

    res.status(201).json({
      success: true,
      jobId: job.id,
      testId,
      delayMs: parsedDelay,
      scheduledFor,
      message: `Delayed test job queued to run in ${parsedDelay}ms`,
    });
  } catch (error) {
    next(error);
  }
}

export async function getQueueStatus(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const counts = await getQueueJobCounts();
    res.status(200).json({
      success: true,
      counts,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}
