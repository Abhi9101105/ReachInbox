import crypto from 'crypto';
import { CookieOptions } from 'express';
import { redisConnection } from '../config/redis';
import { config } from '../config/env';
import { SessionData } from '../types/auth.types';

export const SESSION_COOKIE_NAME = 'reachinbox_session';
export const OAUTH_STATE_COOKIE_NAME = 'reachinbox_oauth_state';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const STATE_TTL_SECONDS = 600; // 10 minutes

export class SessionService {
  /**
   * Generates a cryptographically secure session ID, stores session data in Redis.
   */
  async createSession(data: SessionData): Promise<string> {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const key = `session:${sessionId}`;
    await redisConnection.setex(key, SESSION_TTL_SECONDS, JSON.stringify(data));
    return sessionId;
  }

  /**
   * Retrieves active session from Redis.
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    if (!sessionId || typeof sessionId !== 'string') {
      return null;
    }
    const key = `session:${sessionId}`;
    const raw = await redisConnection.get(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  /**
   * Destroys session in Redis.
   */
  async destroySession(sessionId: string): Promise<void> {
    if (!sessionId || typeof sessionId !== 'string') {
      return;
    }
    const key = `session:${sessionId}`;
    await redisConnection.del(key);
  }

  /**
   * Generates a cryptographically secure CSRF state parameter for OAuth and stores in Redis with 10m TTL.
   */
  async createOAuthState(): Promise<string> {
    const state = crypto.randomBytes(32).toString('hex');
    const key = `oauth_state:${state}`;
    await redisConnection.setex(key, STATE_TTL_SECONDS, '1');
    return state;
  }

  /**
   * Validates and atomically consumes the OAuth state parameter to prevent replay attacks.
   */
  async verifyOAuthState(state: string): Promise<boolean> {
    if (!state || typeof state !== 'string') {
      return false;
    }
    const key = `oauth_state:${state}`;
    // Atomically check and delete state key in Redis
    const deleted = await redisConnection.del(key);
    return deleted > 0;
  }

  /**
   * Standard session cookie options matching security requirements.
   *
   * Production (cross-origin Vercel → Render):
   *   SameSite=none is required so the browser sends the cookie on cross-origin
   *   fetch requests (credentials: 'include') from the Vercel frontend to the
   *   Render backend. SameSite=none MUST be paired with Secure=true.
   *
   * Development (same-origin localhost):
   *   SameSite=lax is sufficient and does not require HTTPS.
   */
  getCookieOptions(): CookieOptions {
    const isProduction = config.nodeEnv === 'production';
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/',
    };
  }

  /**
   * Temporary cookie options for browser-bound OAuth state correlation.
   *
   * In production the OAuth flow crosses origins (Vercel initiates → Google →
   * Render callback), so the state cookie must also be SameSite=none+Secure.
   * In development SameSite=lax is fine.
   */
  getOAuthStateCookieOptions(): CookieOptions {
    const isProduction = config.nodeEnv === 'production';
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: STATE_TTL_SECONDS * 1000,
      path: '/',
    };
  }
}

export const sessionService = new SessionService();

