import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { slackService, SLACK_STATE_COOKIE_NAME } from '../services/slack.service';
import { config } from '../config/env';
import { AppError } from '../middleware/error.middleware';

/**
 * GET /api/slack/oauth
 * Initiates Slack OAuth v2 authorization flow for the authenticated user.
 */
export async function initiateSlackAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      throw new AppError('Authentication required to connect Slack', 401);
    }

    const state = await slackService.createSlackOAuthState(
      req.user.id,
      req.sessionId || 'session_bound'
    );

    // Bind state to initiating browser via short-lived HTTP-only cookie
    res.cookie(SLACK_STATE_COOKIE_NAME, state, slackService.getOAuthStateCookieOptions());

    const authUrl = slackService.generateAuthUrl(state);
    res.redirect(authUrl);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/slack/oauth/callback
 * Handles the Slack OAuth redirect, verifies state & browser binding, persists connection.
 */
export async function handleSlackCallback(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { code, state, error: oauthError } = req.query;
    const cookieState = req.cookies?.[SLACK_STATE_COOKIE_NAME];

    // Always clean up the initiation cookie
    res.clearCookie(SLACK_STATE_COOKIE_NAME, {
      ...slackService.getOAuthStateCookieOptions(),
      maxAge: 0,
    });

    if (oauthError) {
      console.warn('[Slack] OAuth consent error or denied:', oauthError);
      return res.redirect(`${config.frontendUrl}/slack?slack_error=${encodeURIComponent(String(oauthError))}`);
    }

    if (!code || typeof code !== 'string') {
      throw new AppError('Missing authorization code from Slack callback', 400);
    }

    if (!state || typeof state !== 'string') {
      throw new AppError('Missing CSRF state from Slack callback', 400);
    }

    // 1. Browser binding check
    if (!cookieState || typeof cookieState !== 'string') {
      console.warn('[Slack] Missing OAuth initiation cookie on callback (potential cross-browser / CSRF)');
      return res.redirect(`${config.frontendUrl}/slack?slack_error=state_cookie_missing`);
    }

    const stateBuffer = Buffer.from(state);
    const cookieBuffer = Buffer.from(cookieState);
    const statesMatch =
      stateBuffer.length === cookieBuffer.length &&
      crypto.timingSafeEqual(stateBuffer, cookieBuffer);

    if (!statesMatch) {
      console.warn('[Slack] OAuth state parameter does not match initiating browser cookie');
      return res.redirect(`${config.frontendUrl}/slack?slack_error=state_mismatch`);
    }

    // 2. Server-side check & atomic consumption in Redis
    const stateData = await slackService.verifyAndConsumeState(state);
    if (!stateData || !stateData.userId) {
      console.warn('[Slack] Invalid or expired OAuth state received');
      return res.redirect(`${config.frontendUrl}/slack?slack_error=invalid_state`);
    }

    // 3. Exchange authorization code for Slack tokens
    const oauthResponse = await slackService.exchangeCode(code);

    // 4. Persist Slack connection in PostgreSQL for the verified userId
    await slackService.upsertSlackConnection(stateData.userId, oauthResponse);

    // 5. Redirect to frontend with success flag
    res.redirect(`${config.frontendUrl}/slack?slack_connected=true`);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/slack/status
 * Returns current Slack connection status for the authenticated user (NEVER exposes tokens).
 */
export async function getSlackStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      throw new AppError('Authentication required', 401);
    }

    const status = await slackService.getStatus(req.user.id);
    res.status(200).json(status);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/slack/disconnect
 * Disconnects and deletes Slack connection for the authenticated user.
 */
export async function disconnectSlack(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      throw new AppError('Authentication required', 401);
    }

    await slackService.disconnect(req.user.id);

    res.status(200).json({
      success: true,
      message: 'Slack disconnected successfully',
    });
  } catch (error) {
    next(error);
  }
}
