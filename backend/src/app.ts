import express, { Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import routes from './routes';
import { notFoundHandler, errorHandler } from './middleware/error.middleware';
import { config } from './config/env';
import { emailQueue } from './queues/email.queue';

export function createApp(): Express {
  const app = express();

  // Allowed origins: production Vercel frontend + local dev servers.
  // FRONTEND_URL on Render must be set to the exact Vercel URL (no trailing slash).
  const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
  const allowedOrigins = Array.from(
    new Set([
      config.frontendUrl.replace(/\/$/, ''), // strip any trailing slash
      ...devOrigins,
    ])
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow server-to-server requests (no Origin header) and allowed origins
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS: origin '${origin}' not allowed`));
        }
      },
      credentials: true,
    })
  );
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Bull Board Dashboard
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter,
  });
  app.use('/admin/queues', serverAdapter.getRouter());

  // API Routes
  app.use('/api', routes);

  // 404 & Centralized Error Handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();

