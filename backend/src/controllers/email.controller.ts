import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { config } from '../config/env';
import { AppError } from '../middleware/error.middleware';
import { scheduleEmailJob } from '../queues/email.queue';
import { elasticsearchService } from '../services/elasticsearch.service';

/**
 * GET /api/emails?status=SCHEDULED|SENT|FAILED&page=1&limit=20
 * Lists emails for the authenticated user, scoped by ownership.
 */
export async function listEmails(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const {
      status,
      page = '1',
      limit = '20',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const where: Record<string, unknown> = { userId };
    if (status && typeof status === 'string') {
      const validStatuses = ['SCHEDULED', 'PROCESSING', 'SENT', 'FAILED'];
      if (validStatuses.includes(status.toUpperCase())) {
        where.status = status.toUpperCase();
      }
    }

    const [emails, total] = await Promise.all([
      prisma.email.findMany({
        where,
        orderBy: { scheduledAt: 'desc' },
        skip,
        take: limitNum,
        select: {
          id: true,
          recipient: true,
          senderEmail: true,
          subject: true,
          body: true,
          status: true,
          scheduledAt: true,
          sentAt: true,
          errorMessage: true,
          attemptCount: true,
          rateLimitDeferrals: true,
          previewUrl: true,
          createdAt: true,
        },
      }),
      prisma.email.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      emails,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/emails/:id
 * Get a single email by ID, scoped to the authenticated user.
 */
export async function getEmail(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const email = await prisma.email.findFirst({
      where: { id, userId },
    });

    if (!email) {
      throw new AppError('Email not found', 404);
    }

    res.status(200).json({ success: true, email });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/emails
 * Schedule a single email for the authenticated user.
 */
export async function scheduleEmail(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const { recipient, subject, body, scheduledAt } = req.body;

    if (!recipient || typeof recipient !== 'string' || !recipient.includes('@')) {
      throw new AppError('Valid recipient email is required', 400);
    }
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      throw new AppError('Subject is required', 400);
    }
    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      throw new AppError('Body is required', 400);
    }

    let computedDelay = 0;
    let computedScheduledAt: Date;

    if (scheduledAt) {
      const parsed = new Date(scheduledAt);
      if (isNaN(parsed.getTime())) {
        throw new AppError('scheduledAt must be a valid ISO 8601 timestamp', 400);
      }
      computedDelay = Math.max(0, parsed.getTime() - Date.now());
      computedScheduledAt = parsed;
    } else {
      computedScheduledAt = new Date();
    }

    const senderEmail = req.user!.email || config.ethereal.from;

    const email = await prisma.email.create({
      data: {
        userId,
        senderEmail,
        recipient: recipient.trim(),
        subject: subject.trim(),
        body: body.trim(),
        status: 'SCHEDULED',
        scheduledAt: computedScheduledAt,
      },
    });

    const jobOpts = computedDelay > 0 ? { delay: computedDelay } : undefined;
    await scheduleEmailJob(email.id, jobOpts);

    elasticsearchService.indexEmail(email).catch((err) =>
      console.warn(`[Elasticsearch] Async index error on email ${email.id}:`, err.message)
    );

    res.status(201).json({
      success: true,
      email,
      message: computedDelay > 0 ? `Email scheduled for ${computedScheduledAt.toISOString()}` : 'Email queued for immediate delivery',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/emails/batch
 * Schedule a batch of emails for the authenticated user.
 */
export async function scheduleEmailBatch(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.user!.id;
    const { recipients, subject, body, scheduledAt } = req.body;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new AppError('At least one recipient is required', 400);
    }
    if (recipients.length > 5000) {
      throw new AppError('Batch size must not exceed 5000 recipients', 400);
    }
    if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
      throw new AppError('Subject is required', 400);
    }
    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      throw new AppError('Body is required', 400);
    }

    let computedDelay = 0;
    let computedScheduledAt: Date;

    if (scheduledAt) {
      const parsed = new Date(scheduledAt);
      if (isNaN(parsed.getTime())) {
        throw new AppError('scheduledAt must be a valid ISO 8601 timestamp', 400);
      }
      computedDelay = Math.max(0, parsed.getTime() - Date.now());
      computedScheduledAt = parsed;
    } else {
      computedScheduledAt = new Date();
    }

    const senderEmail = req.user!.email || config.ethereal.from;

    const createdEmails = await prisma.$transaction(
      recipients.map((r: string) =>
        prisma.email.create({
          data: {
            userId,
            senderEmail,
            recipient: r.trim(),
            subject: subject.trim(),
            body: body.trim(),
            status: 'SCHEDULED',
            scheduledAt: computedScheduledAt,
          },
        })
      )
    );

    const jobOpts = computedDelay > 0 ? { delay: computedDelay } : undefined;
    await Promise.all(
      createdEmails.map((email: { id: string }) => scheduleEmailJob(email.id, jobOpts))
    );

    elasticsearchService.bulkIndexEmails(createdEmails).catch((err) =>
      console.warn(`[Elasticsearch] Async bulk index error:`, err.message)
    );

    res.status(201).json({
      success: true,
      count: createdEmails.length,
      scheduledAt: computedScheduledAt.toISOString(),
      message: `${createdEmails.length} emails queued${computedDelay > 0 ? ` for ${computedScheduledAt.toISOString()}` : ' for immediate delivery'}`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/emails/search?q=...
 * Search emails via Elasticsearch, scoped to authenticated user.
 */
export async function searchEmails(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { q, status, page, limit } = req.query;

    const result = await elasticsearchService.searchEmails({
      q: typeof q === 'string' ? q : undefined,
      status: typeof status === 'string' ? status : undefined,
      senderEmail: req.user!.email,
      page: page ? parseInt(page as string, 10) : 1,
      limit: limit ? parseInt(limit as string, 10) : 20,
      sortBy: 'scheduledAt',
      sortOrder: 'desc',
    });

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
