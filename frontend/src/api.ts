const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || '/api';

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

class ApiError extends Error {
  status: number;
  data: unknown;
  
  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function request<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options;

  const config: RequestInit = {
    method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body && method !== 'GET') {
    config.body = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${endpoint}`, config);

  if (response.status === 401) {
    // Redirect to login on auth failure
    if (!window.location.pathname.includes('/login')) {
      window.location.href = '/login';
    }
    throw new ApiError('Authentication required', 401);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      data?.error || data?.message || `Request failed with status ${response.status}`,
      response.status,
      data
    );
  }

  return data as T;
}

// ============ Auth API ============

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface AuthResponse {
  authenticated: boolean;
  user: User;
}

export const authApi = {
  getMe: () => request<AuthResponse>('/auth/me'),
  logout: () => request<{ success: boolean }>('/auth/logout', { method: 'POST' }),
  getGoogleAuthUrl: () => `${API_BASE}/auth/google`,
};

// ============ Email API ============

export interface Email {
  id: string;
  recipient: string;
  senderEmail: string;
  subject: string;
  body: string;
  status: 'SCHEDULED' | 'PROCESSING' | 'SENT' | 'FAILED';
  scheduledAt: string;
  sentAt: string | null;
  errorMessage: string | null;
  attemptCount: number;
  rateLimitDeferrals: number;
  previewUrl: string | null;
  createdAt: string;
}

export interface EmailListResponse {
  success: boolean;
  emails: Email[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ScheduleEmailRequest {
  recipient: string;
  subject: string;
  body: string;
  scheduledAt?: string;
}

export interface ScheduleBatchRequest {
  recipients: string[];
  subject: string;
  body: string;
  scheduledAt?: string;
}

export const emailApi = {
  list: (params?: { status?: string; page?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return request<EmailListResponse>(`/emails${qs ? '?' + qs : ''}`);
  },

  get: (id: string) => request<{ success: boolean; email: Email }>(`/emails/${id}`),

  schedule: (data: ScheduleEmailRequest) =>
    request<{ success: boolean; email: Email; message: string }>('/emails', { method: 'POST', body: data }),

  scheduleBatch: (data: ScheduleBatchRequest) =>
    request<{ success: boolean; count: number; message: string }>('/emails/batch', { method: 'POST', body: data }),

  search: (params: { q?: string; status?: string; page?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.status) query.set('status', params.status);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    return request<{ total: number; emails: Email[]; page: number; limit: number }>(`/emails/search?${query.toString()}`);
  },
};

// ============ Slack API ============

export interface SlackStatus {
  connected: boolean;
  workspace?: {
    id: string;
    name: string;
  };
  slackUserId?: string;
}

export const slackApi = {
  getStatus: () => request<SlackStatus>('/slack/status'),
  getOAuthUrl: () => `${API_BASE}/slack/oauth`,
  disconnect: () => request<{ success: boolean }>('/slack/disconnect', { method: 'POST' }),
};

// ============ Queue / Rate Limit API ============

export interface RateLimitStatus {
  success: boolean;
  scope: string;
  currentCount: number;
  limit: number;
  windowSeconds: number;
  minSendDelayMs: number;
  workerConcurrency: number;
}

export interface QueueStatus {
  success: boolean;
  counts: Record<string, number>;
}

export const systemApi = {
  rateLimitStatus: () => request<RateLimitStatus>('/test/rate-limit/status'),
  queueStatus: () => request<QueueStatus>('/test/jobs/status'),
  health: () => request<{ status: string }>('/health'),
};

export { ApiError };
