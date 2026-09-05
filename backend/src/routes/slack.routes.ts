import { Router } from 'express';
import {
  initiateSlackAuth,
  handleSlackCallback,
  getSlackStatus,
  disconnectSlack,
} from '../controllers/slack.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// GET /api/slack/oauth - Start Slack OAuth flow (Authenticated)
router.get('/oauth', requireAuth, initiateSlackAuth);

// GET /api/slack/oauth/callback - Slack OAuth redirect callback
router.get('/oauth/callback', handleSlackCallback);

// GET /api/slack/status - Current Slack connection status (Authenticated)
router.get('/status', requireAuth, getSlackStatus);

// POST /api/slack/disconnect - Disconnect Slack (Authenticated)
router.post('/disconnect', requireAuth, disconnectSlack);

export default router;
