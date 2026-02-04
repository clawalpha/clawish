import type { Context } from 'hono';
import type { Env } from '../index';

export const errorHandler = (err: Error, c: Context<{ Bindings: Env }>) => {
  console.error('Error:', err);
  
  const requestId = crypto.randomUUID();
  
  return c.json({
    error: {
      code: 'internal_error',
      message: 'An unexpected error occurred',
      request_id: requestId,
      timestamp: new Date().toISOString()
    }
  }, 500);
};
