import http from 'http';
import { Socket } from 'net';
import { app } from './app';
import { config } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/prisma';
import { closeRedisConnection } from './config/redis';
import { closeEmailQueue } from './queues/email.queue';
import { initEmailWorker, closeEmailWorker } from './queues/email.worker';
import { emailService } from './services/email.service';
import { elasticsearchService } from './services/elasticsearch.service';

let server: http.Server | null = null;
let shutdownPromise: Promise<void> | null = null;
const activeSockets = new Set<Socket>();

export async function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    console.log(`\nReceived ${signal}. Initiating graceful shutdown...`);

    // Safety fallback: force exit after 2.5 seconds if anything is stuck
    const forceExitTimer = setTimeout(() => {
      console.error('Graceful shutdown timeout exceeded. Forcefully terminating.');
      process.exit(1);
    }, 2500);
    forceExitTimer.unref();

    try {
      // 1. Close HTTP Server & terminate active sockets immediately
      if (server) {
        const serverClosePromise = new Promise<void>((resolve) => {
          server!.close(() => {
            console.log('HTTP server closed.');
            resolve();
          });
        });

        if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
        }
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }

        for (const socket of activeSockets) {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        }
        activeSockets.clear();

        await Promise.race([
          serverClosePromise,
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
      }

      // 2. Gracefully close BullMQ Worker
      await closeEmailWorker();

      // 3. Close BullMQ Queue
      await closeEmailQueue();
      console.log('Email queue closed.');

      // 4. Close Email Service Transporter Pool
      emailService.close();
      console.log('Email service transporter closed.');

      // 5. Close Redis Connection
      await closeRedisConnection();
      console.log('Redis connection closed.');

      // 6. Disconnect Prisma Database
      await disconnectDatabase();
      console.log('PostgreSQL database disconnected.');

      // 7. Close Elasticsearch Client
      await elasticsearchService.close();
      console.log('Elasticsearch client closed.');

      clearTimeout(forceExitTimer);
      console.log('Graceful shutdown complete.');
      process.exit(0);
    } catch (error) {
      console.error('Error during graceful shutdown:', error);
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  })();

  return shutdownPromise;
}

// Global Process Signal Handlers
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGHUP', () => void shutdown('SIGHUP'));

async function startServer(): Promise<void> {
  try {
    // 1. Connect to PostgreSQL
    console.log('Connecting to PostgreSQL database...');
    await connectDatabase();
    console.log('Database connected successfully.');

    // 2. Initialize Elasticsearch (resilient: warnings logged if offline)
    await elasticsearchService.init().catch((esErr) => {
      console.warn('[Elasticsearch] Init warning (will retry on demand):', (esErr as Error).message);
    });

    // 3. Verify SMTP Connection
    try {
      await emailService.verifyConnection();
    } catch (smtpErr) {
      console.warn('SMTP connection warning (will retry on demand):', (smtpErr as Error).message);
    }

    // 4. Initialize BullMQ Worker
    initEmailWorker();

    // 5. Start Express HTTP Server
    server = app.listen(config.port, () => {
      console.log(`ReachInbox Backend running on port ${config.port} [${config.nodeEnv}]`);
      console.log(`Health check: http://localhost:${config.port}/api/health`);
      console.log(`Test email scheduler: http://localhost:${config.port}/api/test/emails`);
      console.log(`Search emails: http://localhost:${config.port}/api/test/search/emails`);
    });

    // Track active client connections for fast shutdown
    server.on('connection', (socket: Socket) => {
      activeSockets.add(socket);
      socket.on('close', () => {
        activeSockets.delete(socket);
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

void startServer();
