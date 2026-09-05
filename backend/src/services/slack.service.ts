import crypto from 'crypto';
import { CookieOptions } from 'express';
import { prisma } from '../config/prisma';
import { redisConnection } from '../config/redis';
import { config } from '../config/env';
import {
  SlackOAuthV2Response,
  SlackStatusResponse,
  SlackStateData,
  RateLimitNotificationParams,
} from '../types/slack.types';

export const SLACK_STATE_COOKIE_NAME = 'reachinbox_slack_state';
export const SLACK_STATE_TTL_SECONDS = 600; // 10 minutes

export class SlackService {
  /**
   * Generates a cryptographically random OAuth state, saves server-side metadata in Redis with 10m TTL.
   */
  async createSlackOAuthState(userId: string, sessionId: string): Promise<string> {
    const state = crypto.randomBytes(32).toString('hex');
    const key = `slack_oauth_state:${state}`;
    const data: SlackStateData = {
      userId,
      sessionId,
      createdAt: new Date().toISOString(),
    };
    await redisConnection.setex(key, SLACK_STATE_TTL_SECONDS, JSON.stringify(data));
    return state;
  }

  /**
   * Validates and atomically consumes the Slack OAuth state parameter from Redis to prevent replay attacks.
   */
  async verifyAndConsumeState(state: string): Promise<SlackStateData | null> {
    if (!state || typeof state !== 'string') {
      return null;
    }
    const key = `slack_oauth_state:${state}`;
    const raw = await redisConnection.get(key);
    if (!raw) {
      return null;
    }
    // Atomic one-time deletion
    await redisConnection.del(key);
    try {
      return JSON.parse(raw) as SlackStateData;
    } catch {
      return null;
    }
  }

  /**
   * Generates the Slack OAuth v2 authorization URL.
   * Scopes requested: chat:write (to send notifications), incoming-webhook (optional channel webhook)
   */
  generateAuthUrl(state: string): string {
    const scopes = ['chat:write', 'incoming-webhook'].join(',');
    const params = new URLSearchParams({
      client_id: config.slack.clientId,
      scope: scopes,
      redirect_uri: config.slack.redirectUri,
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  }

  /**
   * Exchanges authorization code with Slack's oauth.v2.access API.
   */
  async exchangeCode(code: string): Promise<SlackOAuthV2Response> {
    const formData = new URLSearchParams({
      client_id: config.slack.clientId,
      client_secret: config.slack.clientSecret,
      code,
      redirect_uri: config.slack.redirectUri,
    });

    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      throw new Error(`Slack OAuth token exchange HTTP failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SlackOAuthV2Response;
    if (!data.ok) {
      throw new Error(`Slack OAuth returned error: ${data.error || 'Unknown error'}`);
    }

    return data;
  }

  /**
   * Persists or updates the Slack connection in PostgreSQL for the given user.
   */
  async upsertSlackConnection(
    userId: string,
    oauthData: SlackOAuthV2Response
  ): Promise<{ id: string; teamName: string; slackUserId: string }> {
    const teamId = oauthData.team?.id || 'unknown_team';
    const teamName = oauthData.team?.name || 'Slack Workspace';
    const slackUserId = oauthData.authed_user?.id || oauthData.bot_user_id || 'unknown_user';
    const accessToken = oauthData.access_token || oauthData.authed_user?.access_token;
    const channelId = oauthData.incoming_webhook?.channel_id || null;
    const scope = oauthData.scope || oauthData.authed_user?.scope || null;

    if (!accessToken) {
      throw new Error('Slack OAuth response did not contain a usable access token');
    }

    const connection = await prisma.slackConnection.upsert({
      where: { userId },
      create: {
        userId,
        teamId,
        teamName,
        slackUserId,
        channelId,
        accessToken,
        scope,
      },
      update: {
        teamId,
        teamName,
        slackUserId,
        channelId,
        accessToken,
        scope,
        updatedAt: new Date(),
      },
    });

    return {
      id: connection.id,
      teamName: connection.teamName,
      slackUserId: connection.slackUserId,
    };
  }

  /**
   * Retrieves public Slack status for a user (NEVER exposes accessToken).
   */
  async getStatus(userId: string): Promise<SlackStatusResponse> {
    const connection = await prisma.slackConnection.findUnique({
      where: { userId },
      select: {
        id: true,
        teamId: true,
        teamName: true,
        slackUserId: true,
      },
    });

    if (!connection) {
      return { connected: false };
    }

    return {
      connected: true,
      workspace: {
        id: connection.teamId,
        name: connection.teamName,
      },
      slackUserId: connection.slackUserId,
    };
  }

  /**
   * Disconnects and deletes Slack connection for the user.
   * Safe and idempotent; attempts Slack token revocation best-effort.
   */
  async disconnect(userId: string): Promise<boolean> {
    const connection = await prisma.slackConnection.findUnique({
      where: { userId },
    });

    if (!connection) {
      return true; // Idempotent success
    }

    // Attempt token revocation best-effort without blocking local disconnection
    if (connection.accessToken) {
      try {
        await fetch('https://slack.com/api/auth.revoke', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });
      } catch (err) {
        console.warn(`[Slack] Best-effort auth.revoke warning for user ${userId}:`, (err as Error).message);
      }
    }

    await prisma.slackConnection.delete({
      where: { userId },
    });

    return true;
  }

  /**
   * Dispatches a Slack notification when hourly rate limit is reached.
   * Guaranteed:
   * 1. Atomic Redis deduplication (1 message per user + sender + window)
   * 2. Never throws or fails email worker jobs
   * 3. Graceful no-op if user has no Slack connected
   */
  async notifyRateLimitReached(params: RateLimitNotificationParams): Promise<boolean> {
    try {
      const { userId, senderEmail, limit, windowSeconds, windowKey } = params;

      // Deduplication Key: slack:rate-limit-notified:{userId}:{senderEmail}:{windowKey}
      const dedupKey = `slack:rate-limit-notified:${userId}:${senderEmail}:${windowKey}`;
      const ttl = windowSeconds + 120; // Ensure key outlasts the hourly window

      // Atomic SET NX in Redis
      const acquired = await redisConnection.set(dedupKey, '1', 'EX', ttl, 'NX');
      if (acquired !== 'OK') {
        // Notification already sent for this window by this or another concurrent worker
        return false;
      }

      // Check if user has an active Slack connection
      const connection = await prisma.slackConnection.findUnique({
        where: { userId },
      });

      if (!connection || !connection.accessToken) {
        // No Slack connected for this user; normal email scheduling continues
        return false;
      }

      const targetDestination = connection.channelId || connection.slackUserId;
      const messageText =
        `⚠️ *ReachInbox Hourly Email Limit Reached*\n` +
        `• *Sender:* \`${senderEmail}\`\n` +
        `• *Limit:* \`${limit} emails/hour\`\n` +
        `• *Window Key:* \`${windowKey}\`\n` +
        `• *Status:* Limit reached. Queued emails will automatically resume in the next available window.`;

      // Post message to Slack
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: targetDestination,
          text: messageText,
        }),
      });

      const responseData = (await res.json()) as { ok: boolean; error?: string };
      if (!responseData.ok) {
        console.warn(`[Slack] chat.postMessage warning for user ${userId}:`, responseData.error);
        return false;
      }

      console.log(`[Slack] Successfully sent rate-limit notification to user ${userId} for sender ${senderEmail}`);
      return true;
    } catch (error) {
      console.warn(`[Slack] Notification dispatch error (non-fatal):`, (error as Error).message);
      return false;
    }
  }

  /**
   * Cookie options for temporary OAuth initiation state.
   */
  getOAuthStateCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      maxAge: SLACK_STATE_TTL_SECONDS * 1000,
      path: '/',
    };
  }
}

export const slackService = new SlackService();
