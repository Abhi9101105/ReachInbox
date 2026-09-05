import { OAuth2Client } from 'google-auth-library';
import { config } from '../config/env';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/error.middleware';
import { GoogleUserPayload, AuthenticatedUser } from '../types/auth.types';

export class AuthService {
  private oauth2Client: OAuth2Client;

  constructor() {
    this.oauth2Client = new OAuth2Client(
      config.google.clientId,
      config.google.clientSecret,
      config.google.callbackUrl
    );
  }

  /**
   * Generates the Google OAuth authorization URL with CSRF state and OpenID scopes.
   */
  generateAuthUrl(state: string): string {
    if (!config.google.clientId) {
      throw new AppError('Google OAuth is not configured on the server (missing GOOGLE_CLIENT_ID)', 500);
    }

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['openid', 'email', 'profile'],
      prompt: 'consent',
      state,
    });
  }

  /**
   * Exchanges an authorization code for tokens and validates the Google ID token.
   */
  async exchangeCodeAndGetUser(code: string): Promise<GoogleUserPayload> {
    if (!code || typeof code !== 'string') {
      throw new AppError('Missing authorization code', 400);
    }

    try {
      const { tokens } = await this.oauth2Client.getToken(code);

      if (!tokens.id_token) {
        throw new AppError('Google did not return an ID token', 400);
      }

      // Verify ID token cryptographically against Google's public certificates
      const ticket = await this.oauth2Client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.google.clientId,
      });

      const payload = ticket.getPayload();
      if (!payload || !payload.sub || !payload.email) {
        throw new AppError('Invalid Google identity payload', 400);
      }

      return {
        sub: payload.sub,
        email: payload.email.toLowerCase(),
        name: payload.name || payload.email,
        picture: payload.picture,
        email_verified: payload.email_verified,
      };
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      console.error('[AuthService] Google token exchange error:', (err as Error).message);
      throw new AppError('Failed to authenticate with Google. Please try again.', 401);
    }
  }

  /**
   * Upserts the user record in PostgreSQL by Google ID or existing email.
   * Ensures no duplicates are created.
   */
  async upsertGoogleUser(googlePayload: GoogleUserPayload): Promise<AuthenticatedUser> {
    const { sub: googleId, email, name, picture: avatar } = googlePayload;

    // 1. Check if user already exists with this googleId
    let user = await prisma.user.findUnique({
      where: { googleId },
    });

    if (user) {
      // Update profile info if changed
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          name,
          email,
          avatar: avatar || user.avatar,
        },
      });
    } else {
      // 2. Check if a user already exists with the same email (e.g. system or email-created)
      const existingByEmail = await prisma.user.findUnique({
        where: { email },
      });

      if (existingByEmail) {
        // Link googleId to existing user
        user = await prisma.user.update({
          where: { id: existingByEmail.id },
          data: {
            googleId,
            name: existingByEmail.name || name,
            avatar: avatar || existingByEmail.avatar,
          },
        });
      } else {
        // 3. Create new user record
        user = await prisma.user.create({
          data: {
            googleId,
            email,
            name,
            avatar,
          },
        });
      }
    }

    return {
      id: user.id,
      googleId: user.googleId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatar,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  /**
   * Fetches user by internal UUID.
   */
  async getUserById(id: string): Promise<AuthenticatedUser | null> {
    const user = await prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      googleId: user.googleId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatar,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }
}

export const authService = new AuthService();
