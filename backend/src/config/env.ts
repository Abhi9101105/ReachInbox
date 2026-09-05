import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

interface EtherealConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

interface RateLimitConfig {
  emailHourlyLimit: number;
  minSendDelayMs: number;
  rateLimitWindowSeconds: number;
}

interface ElasticsearchConfig {
  url: string;
  index: string;
}

interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface Config {
  port: number;
  nodeEnv: string;
  frontendUrl: string;
  databaseUrl: string;
  redisUrl: string;
  workerConcurrency: number;
  ethereal: EtherealConfig;
  rateLimit: RateLimitConfig;
  elasticsearch: ElasticsearchConfig;
  google: GoogleOAuthConfig;
  slack: SlackOAuthConfig;
}

const getEnvVar = (key: string, defaultValue?: string): string => {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const parsePositiveInt = (key: string, defaultVal: string): number => {
  const val = parseInt(getEnvVar(key, defaultVal), 10);
  if (isNaN(val) || val < 0) {
    throw new Error(`Environment variable ${key} must be a non-negative integer, got: ${getEnvVar(key, defaultVal)}`);
  }
  return val;
};

export const config: Config = {
  port: parseInt(getEnvVar('PORT', '4000'), 10),
  nodeEnv: getEnvVar('NODE_ENV', 'development'),
  frontendUrl: getEnvVar('FRONTEND_URL', 'http://localhost:5173'),
  databaseUrl: getEnvVar(
    'DATABASE_URL',
    'postgresql://postgres:postgres@localhost:5432/reachinbox?schema=public'
  ),
  redisUrl: getEnvVar('REDIS_URL', 'redis://localhost:6379'),
  workerConcurrency: parsePositiveInt('WORKER_CONCURRENCY', '5'),
  ethereal: {
    host: getEnvVar('ETHEREAL_HOST', getEnvVar('SMTP_HOST', 'smtp.ethereal.email')),
    port: parseInt(getEnvVar('ETHEREAL_PORT', getEnvVar('SMTP_PORT', '587')), 10),
    user: getEnvVar('ETHEREAL_USER', getEnvVar('SMTP_USER', '')),
    pass: getEnvVar('ETHEREAL_PASSWORD', getEnvVar('SMTP_PASS', '')),
    from: getEnvVar('EMAIL_FROM', 'ReachInbox Scheduler <no-reply@reachinbox.ai>'),
  },
  rateLimit: {
    emailHourlyLimit: parsePositiveInt('EMAIL_HOURLY_LIMIT', '100'),
    minSendDelayMs: parsePositiveInt('MIN_SEND_DELAY_MS', '1000'),
    rateLimitWindowSeconds: parsePositiveInt('RATE_LIMIT_WINDOW_SECONDS', '3600'),
  },
  elasticsearch: {
    url: getEnvVar('ELASTICSEARCH_URL', 'http://localhost:9200'),
    index: getEnvVar('ELASTICSEARCH_INDEX', 'emails'),
  },
  google: {
    clientId: getEnvVar('GOOGLE_CLIENT_ID', ''),
    clientSecret: getEnvVar('GOOGLE_CLIENT_SECRET', ''),
    callbackUrl: getEnvVar('GOOGLE_CALLBACK_URL', 'http://localhost:4000/api/auth/google/callback'),
  },
  slack: {
    clientId: getEnvVar('SLACK_CLIENT_ID', ''),
    clientSecret: getEnvVar('SLACK_CLIENT_SECRET', ''),
    redirectUri: getEnvVar('SLACK_REDIRECT_URI', 'http://localhost:4000/api/slack/oauth/callback'),
  },
};

