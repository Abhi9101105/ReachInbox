export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
  timestamp?: string;
}

export interface HealthCheckResponse {
  success: boolean;
  message: string;
  timestamp: string;
  environment: string;
  database: {
    status: 'connected' | 'disconnected';
    latencyMs?: number;
  };
  redis?: {
    status: 'connected' | 'disconnected';
    latencyMs?: number;
  };
  elasticsearch?: {
    status: 'connected' | 'disconnected';
    latencyMs?: number;
    clusterStatus?: string;
  };
}
