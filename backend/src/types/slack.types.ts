/**
 * Slack OAuth v2 response structure from https://slack.com/api/oauth.v2.access
 */
export interface SlackOAuthV2Response {
  ok: boolean;
  error?: string;
  app_id?: string;
  authed_user?: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
  };
  scope?: string;
  token_type?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: {
    id: string;
    name: string;
  };
  incoming_webhook?: {
    channel: string;
    channel_id: string;
    configuration_url: string;
    url: string;
  };
}

/**
 * Public Slack status response (NEVER exposes accessToken)
 */
export interface SlackStatusResponse {
  connected: boolean;
  workspace?: {
    id: string;
    name: string;
  };
  slackUserId?: string;
}

/**
 * Server-side state metadata bound to the initiating user & session
 */
export interface SlackStateData {
  userId: string;
  sessionId: string;
  createdAt: string;
}

/**
 * Parameter payload for hourly rate-limit notification
 */
export interface RateLimitNotificationParams {
  userId: string;
  senderEmail: string;
  limit: number;
  windowSeconds: number;
  windowKey: string;
}
