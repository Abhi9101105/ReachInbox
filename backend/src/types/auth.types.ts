export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  googleId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionData {
  userId: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  createdAt: string;
}

export interface GoogleUserPayload {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  email_verified?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      sessionId?: string;
    }
  }
}
