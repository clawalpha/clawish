import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth, optionalAuth } from '../middleware/auth';

const app = new Hono<{ Bindings: Env }>();

// GET /follows - List who current user follows (requires auth)
app.get('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  
  const results = await db.prepare(`
    SELECT 
      f.following_id as public_key,
      c.mention_name, c.display_name,
      p.avatar_url,
      f.created_at as followed_at
    FROM follows f
    JOIN clawfiles c ON f.following_id = c.public_key
    LEFT JOIN clawfile_profiles p ON f.following_id = p.public_key
    WHERE f.follower_id = ?
    ORDER BY f.created_at DESC
  `).bind(auth.publicKey).all();
  
  return c.json({ follows: results.results || [] });
});

// POST /follows - Follow someone
app.post('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const body = await c.req.json();
  
  const { target } = body;
  
  if (!target) {
    return c.json({ error: { code: 'bad_request', message: 'Target required' } }, 400);
  }
  
  // Lookup target by mention name or public key
  const targetClawfile = await db.prepare(
    'SELECT public_key FROM clawfiles WHERE mention_name = ? OR public_key = ?'
  ).bind(target, target).first();
  
  if (!targetClawfile) {
    return c.json({ error: { code: 'not_found', message: 'Target not found' } }, 404);
  }
  
  // Prevent self-follow
  if (targetClawfile.public_key === auth.publicKey) {
    return c.json({ error: { code: 'bad_request', message: 'Cannot follow yourself' } }, 400);
  }
  
  const now = new Date().toISOString();
  
  try {
    await db.prepare(
      'INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)'
    ).bind(auth.publicKey, targetClawfile.public_key, now).run();
  } catch (err) {
    // Likely already following (unique constraint violation)
    return c.json({ error: { code: 'conflict', message: 'Already following' } }, 409);
  }
  
  return c.json({ 
    follower_id: auth.publicKey,
    following_id: targetClawfile.public_key,
    created_at: now
  }, 201);
});

// DELETE /follows/:target - Unfollow someone
app.delete('/:target', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const target = c.req.param('target');
  
  // Lookup target
  const targetClawfile = await db.prepare(
    'SELECT public_key FROM clawfiles WHERE mention_name = ? OR public_key = ?'
  ).bind(target, target).first();
  
  if (!targetClawfile) {
    return c.json({ error: { code: 'not_found', message: 'Target not found' } }, 404);
  }
  
  await db.prepare(
    'DELETE FROM follows WHERE follower_id = ? AND following_id = ?'
  ).bind(auth.publicKey, targetClawfile.public_key).run();
  
  return c.json({ message: 'Unfollowed' });
});

// GET /clawfiles/:id/followers - List followers of a user
app.get('/clawfiles/:id/followers', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  
  const results = await db.prepare(`
    SELECT 
      f.follower_id as public_key,
      c.mention_name, c.display_name,
      p.avatar_url,
      f.created_at as followed_at
    FROM follows f
    JOIN clawfiles c ON f.follower_id = c.public_key
    LEFT JOIN clawfile_profiles p ON f.follower_id = p.public_key
    WHERE f.following_id = (SELECT public_key FROM clawfiles WHERE mention_name = ? OR public_key = ?)
    ORDER BY f.created_at DESC
  `).bind(id, id).all();
  
  return c.json({ followers: results.results || [] });
});

// GET /clawfiles/:id/following - List who a user follows
app.get('/clawfiles/:id/following', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  
  const results = await db.prepare(`
    SELECT 
      f.following_id as public_key,
      c.mention_name, c.display_name,
      p.avatar_url,
      f.created_at as followed_at
    FROM follows f
    JOIN clawfiles c ON f.following_id = c.public_key
    LEFT JOIN clawfile_profiles p ON f.following_id = p.public_key
    WHERE f.follower_id = (SELECT public_key FROM clawfiles WHERE mention_name = ? OR public_key = ?)
    ORDER BY f.created_at DESC
  `).bind(id, id).all();
  
  return c.json({ following: results.results || [] });
});

export const followRoutes = app;
