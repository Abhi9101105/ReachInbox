import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { redisConnection } from '../config/redis';
import { elasticsearchService } from '../services/elasticsearch.service';
import { config } from '../config/env';
import { HealthCheckResponse } from '../types';

export async function getHealth(_req: Request, res: Response): Promise<void> {
  let dbStatus: 'connected' | 'disconnected' = 'disconnected';
  let dbLatencyMs: number | undefined;

  let redisStatus: 'connected' | 'disconnected' = 'disconnected';
  let redisLatencyMs: number | undefined;

  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - start;
    dbStatus = 'connected';
  } catch {
    dbStatus = 'disconnected';
  }

  try {
    const start = Date.now();
    await redisConnection.ping();
    redisLatencyMs = Date.now() - start;
    redisStatus = 'connected';
  } catch {
    redisStatus = 'disconnected';
  }

  const esHealth = await elasticsearchService.healthCheck();

  // Core service requires database and redis; elasticsearch is derived auxiliary
  const isHealthy = dbStatus === 'connected' && redisStatus === 'connected';
  const statusCode = isHealthy ? 200 : 503;

  const response: HealthCheckResponse = {
    success: isHealthy,
    message: isHealthy ? 'ReachInbox backend is running' : 'ReachInbox backend degraded',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    database: {
      status: dbStatus,
      ...(dbLatencyMs !== undefined && { latencyMs: dbLatencyMs }),
    },
    redis: {
      status: redisStatus,
      ...(redisLatencyMs !== undefined && { latencyMs: redisLatencyMs }),
    },
    elasticsearch: {
      status: esHealth.status,
      ...(esHealth.latencyMs !== undefined && { latencyMs: esHealth.latencyMs }),
      ...(esHealth.clusterStatus !== undefined && { clusterStatus: esHealth.clusterStatus }),
    },
  };

  res.status(statusCode).json(response);
}
