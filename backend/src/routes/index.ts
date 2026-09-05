import { Router } from 'express';
import healthRoutes from './health.routes';
import testRoutes from './test.routes';
import authRoutes from './auth.routes';
import slackRoutes from './slack.routes';
import emailRoutes from './email.routes';

const router = Router();

router.use('/', healthRoutes);
router.use('/auth', authRoutes);
router.use('/slack', slackRoutes);
router.use('/emails', emailRoutes);
router.use('/test', testRoutes);

export default router;


