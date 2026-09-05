import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { authService } from '../services/auth.service';
import { sessionService, SESSION_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME } from '../services/session.service';
import { config } from '../config/env';
import { AppError } from '../middleware/error.middleware';

/**
 * GET /api/auth/google
 * Initiates the Google OAuth authorization-code flow.
 * Generates cryptographically secure state, stores in Redis, and binds to browser via temporary HTTP-only cookie.
 */
export async function initiateGoogleAuth(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const state = await sessionService.createOAuthState();
    
    // Bind the state to the initiating browser via a short-lived HTTP-only SameSite=Lax cookie
    res.cookie(OAUTH_STATE_COOKIE_NAME, state, sessionService.getOAuthStateCookieOptions());
    
    const authUrl = authService.generateAuthUrl(state);
    res.redirect(authUrl);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auth/google/callback
 * Handles the Google OAuth redirect with authorization code and browser-bound CSRF state verification.
 */
export async function handleGoogleCallback(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { code, state, error: oauthError } = req.query;
    const cookieState = req.cookies?.[OAUTH_STATE_COOKIE_NAME];

    // Always clean up the temporary initiation cookie on callback
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
      ...sessionService.getOAuthStateCookieOptions(),
      maxAge: 0,
    });

    if (oauthError) {
      console.warn('[Auth] Google OAuth consent error or denied:', oauthError);
      return res.redirect(`${config.frontendUrl}?auth_error=${encodeURIComponent(String(oauthError))}`);
    }

    if (!code || typeof code !== 'string') {
      throw new AppError('Missing authorization code from Google OAuth callback', 400);
    }

    if (!state || typeof state !== 'string') {
      throw new AppError('Missing CSRF state from Google OAuth callback', 400);
    }

    // 1. Browser binding check: ensure the callback was received by the same browser that initiated the flow
    if (!cookieState || typeof cookieState !== 'string') {
      console.warn('[Auth] Missing OAuth initiation cookie on callback (potential cross-browser / CSRF attack)');
      return res.redirect(`${config.frontendUrl}?auth_error=state_cookie_missing`);
    }

    // Timing-safe comparison to prevent timing side-channels
    const stateBuffer = Buffer.from(state);
    const cookieBuffer = Buffer.from(cookieState);
    const statesMatch = stateBuffer.length === cookieBuffer.length && crypto.timingSafeEqual(stateBuffer, cookieBuffer);

    if (!statesMatch) {
      console.warn('[Auth] OAuth state parameter does not match initiating browser cookie');
      return res.redirect(`${config.frontendUrl}?auth_error=state_mismatch`);
    }

    // 2. Server-side check: verify state in Redis and atomically consume it to prevent replay
    const isValidState = await sessionService.verifyOAuthState(state);
    if (!isValidState) {
      console.warn('[Auth] Invalid or expired OAuth state parameter received');
      return res.redirect(`${config.frontendUrl}?auth_error=invalid_state`);
    }

    // Exchange authorization code for validated Google user profile
    const googleUser = await authService.exchangeCodeAndGetUser(code);

    // Upsert user in PostgreSQL database
    const user = await authService.upsertGoogleUser(googleUser);

    // Create Redis session
    const sessionId = await sessionService.createSession({
      userId: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      createdAt: new Date().toISOString(),
    });

    // Set secure HTTP-only cookie
    res.cookie(SESSION_COOKIE_NAME, sessionId, sessionService.getCookieOptions());

    // Redirect user to the frontend dashboard
    res.redirect(config.frontendUrl);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auth/me
 * Returns profile info of the currently authenticated session.
 */
export async function getMe(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Not authenticated', 401);
    }

    res.status(200).json({
      authenticated: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        avatarUrl: req.user.avatarUrl || null,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/logout
 * Destroys the active Redis session and clears the HTTP-only cookie.
 */
export async function logout(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionId = req.sessionId || req.cookies?.[SESSION_COOKIE_NAME];

    if (sessionId) {
      await sessionService.destroySession(sessionId);
    }

    res.clearCookie(SESSION_COOKIE_NAME, {
      ...sessionService.getCookieOptions(),
      maxAge: 0,
    });

    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/auth/protected-test
 * Verification route requiring active authentication.
 */
export async function protectedTest(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    res.status(200).json({
      authenticated: true,
      user: req.user,
      message: 'Protected route accessed successfully',
    });
  } catch (error) {
    next(error);
  }
}
