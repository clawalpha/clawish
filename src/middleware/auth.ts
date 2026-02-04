import type { MiddlewareHandler } from 'hono';
import { verifySignature } from '../utils/crypto';

export interface AuthContext {
  publicKey: string;
  identity?: {
    mention_name: string;
    display_name: string;
    verification_tier: number;
    status: string;
  };
}

// Verify Ed25519 signature on incoming requests
export const authMiddleware = (options?: { required?: boolean }): MiddlewareHandler => {
  return async (c, next) => {
    const required = options?.required ?? true;
    
    const publicKey = c.req.header('X-Public-Key');
    const signature = c.req.header('X-Signature');
    const timestamp = c.req.header('X-Timestamp');
    
    if (!publicKey || !signature || !timestamp) {
      if (required) {
        return c.json({ 
          error: { 
            code: 'missing_auth', 
            message: 'X-Public-Key, X-Signature, and X-Timestamp headers required' 
          } 
        }, 401);
      }
      return next();
    }
    
    // Validate timestamp (prevent replay attacks)
    const now = Math.floor(Date.now() / 1000);
    const reqTime = Math.floor(new Date(timestamp).getTime() / 1000);
    const skew = Math.abs(now - reqTime);
    
    if (skew > 60) {
      return c.json({ 
        error: { 
          code: 'timestamp_skew', 
          message: `Timestamp skew too large (${skew}s). Check system clock.` 
        } 
      }, 401);
    }
    
    // Build canonical string
    const method = c.req.method;
    const path = c.req.url.replace(c.req.url.split('/api')[0], '');
    const body = await c.req.raw.clone().text();
    const bodyHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const bodyHashHex = Array.from(new Uint8Array(bodyHash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    
    const canonicalString = `${method} ${path}\n${timestamp}\n${bodyHashHex}`;
    
    // Verify signature
    const isValid = await verifySignature(publicKey, canonicalString, signature);
    
    if (!isValid) {
      return c.json({ 
        error: { 
          code: 'invalid_signature', 
          message: 'Signature verification failed' 
        } 
      }, 401);
    }
    
    // Lookup identity in database
    const db = c.env.DB;
    const identity = await db.prepare(
      'SELECT mention_name, display_name, verification_tier, status FROM clawfiles WHERE public_key = ?'
    ).bind(publicKey).first();
    
    if (!identity) {
      return c.json({ 
        error: { 
          code: 'unknown_identity', 
          message: 'Public key not registered' 
        } 
      }, 401);
    }
    
    if (identity.status !== 'active') {
      return c.json({ 
        error: { 
          code: 'inactive_identity', 
          message: `Identity status: ${identity.status}` 
        } 
      }, 401);
    }
    
    // Attach auth context
    c.set('auth', { publicKey, identity } as AuthContext);
    
    await next();
  };
};

// Optional auth (for reads that benefit from knowing who you are)
export const optionalAuth = authMiddleware({ required: false });

// Required auth (for writes and sensitive reads)
export const requireAuth = authMiddleware({ required: true });
