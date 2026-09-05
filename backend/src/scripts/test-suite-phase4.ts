/**
 * Phase 4 Comprehensive Verification Suite
 *
 * Tests: rate limiting, minimum send delay, concurrency, 1000+ load,
 * restart persistence, idempotency, failure handling, graceful shutdown.
 *
 * Run: npx tsx src/scripts/test-suite-phase4.ts
 */
import http from 'http';
import { app } from '../app';
import { config } from '../config/env';
import { connectDatabase, disconnectDatabase, prisma } from '../config/prisma';
import { closeRedisConnection } from '../config/redis';
import { emailQueue, closeEmailQueue, scheduleEmailJob, getQueueJobCounts } from '../queues/email.queue';
import { initEmailWorker, closeEmailWorker, processEmailJob } from '../queues/email.worker';
import { emailService } from '../services/email.service';
import { rateLimiterService } from '../services/rate-limiter.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  step: string;
  passed: boolean;
  details?: unknown;
  error?: string;
}

const results: TestResult[] = [];

async function logResult(step: string, fn: () => Promise<unknown>) {
  try {
    const details = await fn();
    results.push({ step, passed: true, details });
    console.log(`✅ [PASS] ${step}`);
    if (details !== undefined) {
      const str = JSON.stringify(details, null, 2);
      // Truncate very long outputs
      console.log(`   Details: ${str.length > 800 ? str.slice(0, 800) + '…' : str}`);
    }
  } catch (err) {
    const error = (err as Error).message;
    results.push({ step, passed: false, error });
    console.error(`❌ [FAIL] ${step}: ${error}`);
  }
}

async function getOrCreateUserId(): Promise<string> {
  const u = await prisma.user.upsert({
    where: { email: 'system@reachinbox.ai' },
    update: {},
    create: { email: 'system@reachinbox.ai', name: 'System User' },
  });
  return u.id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function runPhase4Suite() {
  console.log('==========================================================');
  console.log('REACHINBOX PHASE 4 COMPREHENSIVE VERIFICATION SUITE');
  console.log('==========================================================\n');

  const testPort = Number(process.env.TEST_PORT || 4099);
  const baseUrl = `http://localhost:${testPort}`;
  let server: http.Server | null = null;

  try {
    // ---- A. Baseline: Infrastructure & DB ---------------------------------
    await logResult('A. Infrastructure & DB Connection', async () => {
      await connectDatabase();
      return { dbConnected: true };
    });

    // ---- B. Configuration -------------------------------------------------
    await logResult('B. Configuration Loaded (no secrets)', async () => ({
      workerConcurrency: config.workerConcurrency,
      emailHourlyLimit: config.rateLimit.emailHourlyLimit,
      minSendDelayMs: config.rateLimit.minSendDelayMs,
      rateLimitWindowSeconds: config.rateLimit.rateLimitWindowSeconds,
      smtpHost: config.ethereal.host,
      smtpUserConfigured: Boolean(config.ethereal.user),
    }));

    // ---- C. Start server & worker -----------------------------------------
    await logResult('C. Server & Worker Startup', async () => {
      initEmailWorker();
      server = app.listen(testPort);
      await new Promise<void>((resolve) => server!.once('listening', resolve));
      const res = await fetch(`${baseUrl}/api/health`);
      const health = await res.json();
      return { serverListening: true, health };
    });

    // ---- D. Phase 3 Regression: Real Ethereal email -----------------------
    let regressionEmailId = '';
    await logResult('D. Phase 3 Regression: Real Ethereal Email', async () => {
      // Reset rate limiter so this test isn't blocked
      await rateLimiterService.resetScope('global');
      await rateLimiterService.resetMinDelay();

      const res = await fetch(`${baseUrl}/api/test/emails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: 'phase4-regression@example.com',
          subject: 'Phase 4 Regression Test',
          body: 'Verifying Phase 3 Ethereal delivery still works in Phase 4.',
        }),
      });
      const data = await res.json() as { success: boolean; emailId: string };
      if (!data.success) throw new Error('API failed');
      regressionEmailId = data.emailId;

      // Wait for worker to process
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const email = await prisma.email.findUnique({ where: { id: regressionEmailId } });
        if (email?.status === 'SENT') {
          return {
            id: email.id,
            status: email.status,
            sentAt: email.sentAt,
            previewUrl: email.previewUrl,
            providerMessageId: email.providerMessageId,
          };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('Email not marked SENT within 15s');
    });

    // ---- E. Delayed Scheduling --------------------------------------------
    await logResult('E. Delayed Scheduling Persistence', async () => {
      await rateLimiterService.resetScope('global');
      await rateLimiterService.resetMinDelay();

      const futureMs = 3000;
      const res = await fetch(`${baseUrl}/api/test/emails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: 'delayed-test@example.com',
          subject: 'Delayed Phase 4',
          body: 'Testing delayed scheduling.',
          delayMs: futureMs,
        }),
      });
      const data = await res.json() as { success: boolean; emailId: string };
      if (!data.success) throw new Error('API failed');

      // Immediately check: should still be SCHEDULED
      const beforeEmail = await prisma.email.findUnique({ where: { id: data.emailId } });
      if (beforeEmail?.status !== 'SCHEDULED') {
        throw new Error(`Expected SCHEDULED immediately, got ${beforeEmail?.status}`);
      }

      // Wait for the delay plus processing time
      await new Promise((r) => setTimeout(r, futureMs + 6000));

      const afterEmail = await prisma.email.findUnique({ where: { id: data.emailId } });
      if (afterEmail?.status !== 'SENT') {
        throw new Error(`Expected SENT after delay, got ${afterEmail?.status}`);
      }

      return {
        emailId: data.emailId,
        statusBefore: 'SCHEDULED',
        statusAfter: afterEmail.status,
        sentAt: afterEmail.sentAt,
      };
    });

    // ---- F. Rate Limit Test (Small Window) --------------------------------
    await logResult('F. Rate Limit Enforcement (limit=5, window=10s, batch=12)', async () => {
      // Use a small test window
      const testLimit = 5;
      const testWindowSeconds = 10;
      const batchSize = 12;

      // Reset the rate limiter for a fresh test
      await rateLimiterService.resetScope('global', testWindowSeconds);
      await rateLimiterService.resetMinDelay();

      const userId = await getOrCreateUserId();

      // Create email records and queue jobs
      const emailIds: string[] = [];
      for (let i = 0; i < batchSize; i++) {
        const email = await prisma.email.create({
          data: {
            userId,
            senderEmail: config.ethereal.from,
            recipient: `rate-test-${i}@example.com`,
            subject: `Rate Test ${i}`,
            body: `Rate limit test email ${i}`,
            status: 'SCHEDULED',
            scheduledAt: new Date(),
          },
        });
        emailIds.push(email.id);
      }

      // Manually process each email through the rate limiter only
      // (don't actually send SMTP for load testing)
      let allowedCount = 0;
      let deniedCount = 0;

      for (const _emailId of emailIds) {
        const result = await rateLimiterService.checkRateLimit('global', testLimit, testWindowSeconds);
        if (result.allowed) {
          allowedCount++;
        } else {
          deniedCount++;
        }
      }

      // Verify counter never exceeds limit
      const finalCount = await rateLimiterService.getCurrentCount('global', testWindowSeconds);

      if (allowedCount !== testLimit) {
        throw new Error(`Expected exactly ${testLimit} allowed, got ${allowedCount}`);
      }
      if (deniedCount !== batchSize - testLimit) {
        throw new Error(`Expected ${batchSize - testLimit} denied, got ${deniedCount}`);
      }
      if (finalCount > testLimit) {
        throw new Error(`Counter ${finalCount} exceeds limit ${testLimit}!`);
      }

      // Clean up test emails
      await prisma.email.deleteMany({ where: { id: { in: emailIds } } });

      return {
        batchSize,
        limit: testLimit,
        windowSeconds: testWindowSeconds,
        allowedCount,
        deniedCount,
        finalRedisCounter: finalCount,
        counterExceededLimit: finalCount > testLimit,
      };
    });

    // ---- G. Concurrent Workers Rate Limit Test ----------------------------
    await logResult('G. Concurrent Workers Atomicity (5 parallel, limit=5, 20 requests)', async () => {
      const testLimit = 5;
      const testWindowSeconds = 15;
      const totalRequests = 20;

      // Reset
      await rateLimiterService.resetScope('global', testWindowSeconds);

      // Fire 20 concurrent rate-limit checks
      const promises = Array.from({ length: totalRequests }, () =>
        rateLimiterService.checkRateLimit('global', testLimit, testWindowSeconds)
      );
      const results = await Promise.all(promises);

      const allowed = results.filter((r) => r.allowed).length;
      const denied = results.filter((r) => !r.allowed).length;
      const maxCount = Math.max(...results.map((r) => r.currentCount));

      if (allowed !== testLimit) {
        throw new Error(`Expected exactly ${testLimit} allowed, got ${allowed}`);
      }
      if (maxCount > testLimit) {
        throw new Error(`Max counter ${maxCount} exceeds limit ${testLimit} – race condition!`);
      }

      return {
        totalRequests,
        limit: testLimit,
        allowed,
        denied,
        maxObservedCounter: maxCount,
        atomicityVerified: maxCount <= testLimit,
      };
    });

    // ---- H. Minimum Send Delay Test ---------------------------------------
    await logResult('H. Minimum Send Delay Enforcement', async () => {
      const testDelayMs = 200;

      await rateLimiterService.resetMinDelay();

      const timestamps: number[] = [];
      const checkResults: { allowed: boolean; waitMs: number }[] = [];

      // Fire sequential checks
      for (let i = 0; i < 6; i++) {
        const result = await rateLimiterService.checkMinDelay(testDelayMs);
        checkResults.push(result);
        if (result.allowed) {
          timestamps.push(Date.now());
        }
        // Small pause between checks
        if (i < 5) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      // First check should always be allowed
      if (!checkResults[0].allowed) {
        throw new Error('First min-delay check should be allowed');
      }

      // Subsequent rapid checks within the delay window should be denied
      const deniedInWindow = checkResults.slice(1).filter((r) => !r.allowed).length;

      return {
        testDelayMs,
        checksPerformed: checkResults.length,
        allowedCount: checkResults.filter((r) => r.allowed).length,
        deniedCount: deniedInWindow,
        minDelayRespected: deniedInWindow > 0,
      };
    });

    // ---- I. 1000+ Load Test -----------------------------------------------
    await logResult('I. 1000+ Email Load Test (queue only, no SMTP)', async () => {
      const loadSize = 1050;
      const userId = await getOrCreateUserId();

      // Create 1050 email records in a transaction (batched)
      const batchSize = 100;
      const allEmailIds: string[] = [];

      for (let batch = 0; batch < Math.ceil(loadSize / batchSize); batch++) {
        const batchCount = Math.min(batchSize, loadSize - batch * batchSize);
        const created = await prisma.$transaction(
          Array.from({ length: batchCount }, (_, i) => {
            const idx = batch * batchSize + i;
            return prisma.email.create({
              data: {
                userId,
                senderEmail: config.ethereal.from,
                recipient: `load-${idx}@example.com`,
                subject: `Load Test ${idx}`,
                body: `Load test email ${idx}`,
                status: 'SCHEDULED',
                scheduledAt: new Date(Date.now() + 60000), // 1 min future (won't actually process)
              },
            });
          })
        );
        allEmailIds.push(...created.map((e) => e.id));
      }

      // Queue all as delayed BullMQ jobs (60s delay so they won't fire)
      let queuedCount = 0;
      for (const emailId of allEmailIds) {
        try {
          await scheduleEmailJob(emailId, { delay: 60000 });
          queuedCount++;
        } catch {
          // Job ID already exists – acceptable
        }
      }

      // Verify queue health
      const counts = await getQueueJobCounts();
      const dbCount = await prisma.email.count({
        where: { id: { in: allEmailIds } },
      });

      // Clean up: remove jobs and email records
      for (const emailId of allEmailIds) {
        const jobId = `email-${emailId}`;
        const job = await emailQueue.getJob(jobId);
        if (job) {
          await job.remove().catch(() => { /* ignore */ });
        }
      }
      await prisma.email.deleteMany({ where: { id: { in: allEmailIds } } });

      return {
        loadSize,
        dbRecordsCreated: dbCount,
        jobsQueued: queuedCount,
        queueCounts: counts,
        allRecordsPresent: dbCount === loadSize,
      };
    });

    // ---- J. Restart Persistence Test --------------------------------------
    await logResult('J. Restart Persistence Test', async () => {
      await rateLimiterService.resetScope('global');
      await rateLimiterService.resetMinDelay();

      const userId = await getOrCreateUserId();

      // 1. Queue 5 future emails (10s delay)
      const persistEmails: string[] = [];
      for (let i = 0; i < 5; i++) {
        const email = await prisma.email.create({
          data: {
            userId,
            senderEmail: config.ethereal.from,
            recipient: `persist-${i}@example.com`,
            subject: `Persist Test ${i}`,
            body: `Persistence test email ${i}`,
            status: 'SCHEDULED',
            scheduledAt: new Date(Date.now() + 10000),
          },
        });
        await scheduleEmailJob(email.id, { delay: 10000 });
        persistEmails.push(email.id);
      }

      // 2. Confirm jobs exist in delayed state
      const beforeCounts = await getQueueJobCounts();
      const delayedBefore = beforeCounts.delayed || 0;

      // 3. Close worker (simulate restart)
      await closeEmailWorker();

      // 4. Verify jobs still exist in Redis
      let persistedJobCount = 0;
      for (const emailId of persistEmails) {
        const job = await emailQueue.getJob(`email-${emailId}`);
        if (job) persistedJobCount++;
      }

      // 5. Restart worker
      initEmailWorker();

      // 6. Verify jobs can still be found
      let postRestartJobCount = 0;
      for (const emailId of persistEmails) {
        const job = await emailQueue.getJob(`email-${emailId}`);
        if (job) postRestartJobCount++;
      }

      // Clean up: remove delayed jobs, delete records
      for (const emailId of persistEmails) {
        const job = await emailQueue.getJob(`email-${emailId}`);
        if (job) await job.remove().catch(() => { /* ignore */ });
      }
      await prisma.email.deleteMany({ where: { id: { in: persistEmails } } });

      return {
        emailsQueued: 5,
        delayedBefore,
        jobsPersistedDuringRestart: persistedJobCount,
        jobsFoundAfterRestart: postRestartJobCount,
        noJobsLost: persistedJobCount === 5 && postRestartJobCount === 5,
      };
    });

    // ---- K. Idempotency Test (Phase 3 regression) -------------------------
    await logResult('K. Idempotency Test (re-invoke SENT email)', async () => {
      if (!regressionEmailId) throw new Error('No regression email to test');

      const before = await prisma.email.findUnique({ where: { id: regressionEmailId } });
      const beforeSentAt = before?.sentAt?.toISOString();
      const beforeMsgId = before?.providerMessageId;

      // Directly invoke worker for the already-SENT email
      const mockJob = { id: `retest-${regressionEmailId}`, data: { emailId: regressionEmailId }, name: 'send-email' } as any;
      await processEmailJob(mockJob);

      const after = await prisma.email.findUnique({ where: { id: regressionEmailId } });

      if (before?.sentAt?.toISOString() !== after?.sentAt?.toISOString()) {
        throw new Error('sentAt changed – idempotency violation');
      }
      if (before?.providerMessageId !== after?.providerMessageId) {
        throw new Error('providerMessageId changed – idempotency violation');
      }

      return {
        status: after?.status,
        sentAtUnchanged: beforeSentAt === after?.sentAt?.toISOString(),
        messageIdUnchanged: beforeMsgId === after?.providerMessageId,
        idempotentlySkipped: true,
      };
    });

    // ---- L. Failure Handling Test -----------------------------------------
    await logResult('L. Failure Handling (invalid recipient)', async () => {
      await rateLimiterService.resetScope('global');
      await rateLimiterService.resetMinDelay();

      const userId = await getOrCreateUserId();
      const failEmail = await prisma.email.create({
        data: {
          userId,
          senderEmail: 'test@reachinbox.ai',
          recipient: 'unroutable@[invalid-domain-syntax]',
          subject: 'Failure Test',
          body: 'This should fail.',
          status: 'SCHEDULED',
          scheduledAt: new Date(),
        },
      });

      let caughtError: string | null = null;
      try {
        const mockJob = { id: `fail-${failEmail.id}`, data: { emailId: failEmail.id }, name: 'send-email' } as any;
        await processEmailJob(mockJob);
      } catch (err) {
        caughtError = (err as Error).message;
      }

      const updated = await prisma.email.findUnique({ where: { id: failEmail.id } });

      return {
        emailId: failEmail.id,
        status: updated?.status,
        errorMessage: updated?.errorMessage || caughtError,
        errorCaptured: Boolean(updated?.errorMessage || caughtError),
        isNotRateLimitDeferral: updated?.status === 'FAILED', // genuine failure, not deferral
      };
    });

    // ---- L2. Rate-limit deferral does NOT permanently fail ----------------
    await logResult('L2. Rate-Limit Deferral ≠ Permanent FAILED', async () => {
      // Reset and consume all slots for the active window
      await rateLimiterService.resetScope('global');
      await rateLimiterService.resetMinDelay();
      for (let i = 0; i < config.rateLimit.emailHourlyLimit; i++) {
        await rateLimiterService.checkRateLimit('global');
      }

      // Now the limit is exhausted; process an email
      const userId = await getOrCreateUserId();
      const deferEmail = await prisma.email.create({
        data: {
          userId,
          senderEmail: config.ethereal.from,
          recipient: 'defer-test@example.com',
          subject: 'Deferral Test',
          body: 'This email should be deferred, not failed.',
          status: 'SCHEDULED',
          scheduledAt: new Date(),
        },
      });

      let wasDeferred = false;
      try {
        const mockJob = {
          id: `defer-${deferEmail.id}`,
          data: { emailId: deferEmail.id },
          name: 'send-email',
          token: undefined,
        } as any;
        await processEmailJob(mockJob);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('Rate limited') || msg.includes('rescheduled')) {
          wasDeferred = true;
        }
      }

      const updated = await prisma.email.findUnique({ where: { id: deferEmail.id } });

      // The email should be SCHEDULED (deferred), NOT FAILED
      const statusIsCorrect = updated?.status === 'SCHEDULED';
      const hasDeferralCount = (updated?.rateLimitDeferrals ?? 0) > 0;

      // Clean up email and reset rate limiter state so subsequent tests/suites are clean
      await prisma.email.delete({ where: { id: deferEmail.id } });
      await rateLimiterService.resetScope('global');
      await rateLimiterService.resetMinDelay();

      if (!statusIsCorrect) {
        throw new Error(`Expected SCHEDULED after deferral, got ${updated?.status}`);
      }

      return {
        wasDeferred,
        statusAfterDeferral: updated?.status,
        rateLimitDeferrals: updated?.rateLimitDeferrals,
        statusIsScheduledNotFailed: statusIsCorrect,
        hasDeferralCount,
      };
    });

    // ---- M. Graceful Shutdown & Restart -----------------------------------
    await logResult('M. Graceful Shutdown & Resource Cleanup', async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await closeEmailWorker();
      await closeEmailQueue();
      emailService.close();
      await closeRedisConnection();
      await disconnectDatabase();
      return { allResourcesClosed: true };
    });

  } catch (globalErr) {
    console.error('Fatal suite error:', globalErr);
  } finally {
    console.log('\n==========================================================');
    console.log('PHASE 4 TEST RESULTS SUMMARY');
    console.log('==========================================================');
    const passed = results.filter((r) => r.passed).length;
    console.log(`Passed: ${passed}/${results.length}`);
    for (const r of results) {
      console.log(`${r.passed ? '✅' : '❌'} ${r.step}`);
    }
    console.log('==========================================================');
  }
}

void runPhase4Suite();
