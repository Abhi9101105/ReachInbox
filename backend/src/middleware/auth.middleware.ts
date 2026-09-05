import { Request, Response, NextFunction } from 'express';
import { sessionService, SESSION_COOKIE_NAME } from '../services/session.service';
import { AppError } from './error.middleware';

/**
 * Extracts session ID strictly from the secure HTTP-only cookie.
 * (Bearer header support removed to prevent raw session ID exposure in client-side scripts)
 */
function extractSessionId(req: Request): string | null {
  if (req.cookies && typeof req.cookies[SESSION_COOKIE_NAME] === 'string') {
    return req.cookies[SESSION_COOKIE_NAME];
  }
  return null;
}

/**
 * Middleware that requires an active authenticated session.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionId = extractSessionId(req);

    if (!sessionId) {
      throw new AppError('Authentication required. Please log in.', 401);
    }

    const sessionData = await sessionService.getSession(sessionId);
    if (!sessionData) {
      throw new AppError('Session expired or invalid. Please log in again.', 401);
    }

    // Attach session and user details to request
    req.sessionId = sessionId;
    req.user = {
      id: sessionData.userId,
      email: sessionData.email,
      name: sessionData.name,
      avatarUrl: sessionData.avatarUrl,
    };

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware that optionally resolves an authenticated user if a valid session exists.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionId = extractSessionId(req);
    if (sessionId) {
      const sessionData = await sessionService.getSession(sessionId);
      if (sessionData) {
        req.sessionId = sessionId;
        req.user = {
          id: sessionData.userId,
          email: sessionData.email,
          name: sessionData.name,
          avatarUrl: sessionData.avatarUrl,
        };
      }
    }
    next();
  } catch {
    next();
  }
}
