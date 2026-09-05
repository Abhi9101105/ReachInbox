import { Router } from 'express';
import {
  listEmails,
  getEmail,
  scheduleEmail,
  scheduleEmailBatch,
  searchEmails,
} from '../controllers/email.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// All email routes require authentication
router.use(requireAuth);

// Email CRUD
router.get('/', listEmails);
router.get('/search', searchEmails);
router.get('/:id', getEmail);
router.post('/', scheduleEmail);
router.post('/batch', scheduleEmailBatch);

export default router;
