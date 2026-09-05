import { Request, Response, NextFunction } from 'express';
import { ApiResponse } from '../types';
import { config } from '../config/env';

export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Middleware to handle unknown / 404 routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  const response: ApiResponse = {
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
  };
  res.status(404).json(response);
}

/**
 * Centralized error-handling middleware
 */
export function errorHandler(
  err: Error | AppError,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const statusCode = err instanceof AppError ? err.statusCode : 500;
  const message = err.message || 'Internal Server Error';

  if (config.nodeEnv === 'development' && statusCode === 500) {
    console.error('Unhandled Server Error:', err);
  }

  const response: ApiResponse = {
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
  };

  res.status(statusCode).json(response);
}
