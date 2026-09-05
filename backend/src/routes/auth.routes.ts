import { Router } from 'express';
import {
  initiateGoogleAuth,
  handleGoogleCallback,
  getMe,
  logout,
  protectedTest,
} from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// OAuth flow initiation & callback
router.get('/google', initiateGoogleAuth);
router.get('/google/callback', handleGoogleCallback);

// Session inspection & termination
router.get('/me', requireAuth, getMe);
router.post('/logout', logout);

// Verification endpoint for auth middleware
router.get('/protected-test', requireAuth, protectedTest);

export default router;
