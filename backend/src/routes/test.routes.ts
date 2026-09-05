import { Router } from 'express';
import {
  scheduleTestEmail,
  scheduleTestEmailBatch,
  getTestEmail,
  getRateLimitStatus,
  searchTestEmails,
  reindexTestEmails,
  createTestJob,
  createDelayedJob,
  getQueueStatus,
} from '../controllers/test.controller';
import { optionalAuth } from '../middleware/auth.middleware';

const router = Router();

// Email Scheduling Endpoints
router.post('/emails', optionalAuth, scheduleTestEmail);
router.post('/emails/batch', optionalAuth, scheduleTestEmailBatch);
router.get('/emails/:id', getTestEmail);

// Elasticsearch Search & Reindex Endpoints
router.get('/search/emails', searchTestEmails);
router.post('/search/reindex', reindexTestEmails);

// Rate Limit Diagnostics
router.get('/rate-limit/status', getRateLimitStatus);

// Job Queue Testing Endpoints
router.post('/jobs', createTestJob);
router.post('/jobs/delayed', createDelayedJob);
router.get('/jobs/status', getQueueStatus);

export default router;
