import { PrismaClient } from '@prisma/client';
import { config } from './env';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: config.nodeEnv === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (config.nodeEnv !== 'production') {
  global.prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await Promise.race([
      prisma.$disconnect(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Database disconnect timed out')), 500)
      ),
    ]);
  } catch (err) {
    console.warn('Database disconnect error/timeout:', err);
  }
}
