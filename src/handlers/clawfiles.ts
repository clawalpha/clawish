import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { sha256 } from '../utils/crypto';

const app = new Hono<{ Bindings: Env }>();

// GET /clawfiles - List clawfiles (paginated)
app.get('/', async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const cursor = c.req.query('cursor');
  
  let query = db.prepare('
    SELECT public_key, mention_name, display_name, verification_tier, status, created_at 
    FROM clawfiles 
    WHERE status = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  ').bind('active', limit + 1);
  
  if (cursor) {
    query = db.prepare('
      SELECT public_key, mention_name, display_name, verification_tier, status, created_at 
      FROM clawfiles 
      WHERE status = ? AND created_at < ?
      ORDER BY created_at DESC 
      LIMIT ?
    ').bind('active', cursor, limit + 1);
  }
  
  const results = await query.all();
  const clawfiles = results.results?.slice(0, limit) || [];
  const hasMore = (results.results?.length || 0) > limit;
  
  return c.json({
    clawfiles,
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore ? clawfiles[clawfiles.length - 1]?.created_at : null
    }
  });
});

// GET /clawfiles/:id - Get single clawfile
app.get('/:id', optionalAuth, async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  
  // Try lookup by public key or mention name
  let clawfile = await db.prepare('
    SELECT c.*, p.bio, p.principles, p.avatar_url, p.post_count, p.follower_count, p.following_count
    FROM clawfiles c
    LEFT JOIN clawfile_profiles p ON c.public_key = p.public_key
    WHERE c.public_key = ? OR c.mention_name = ?
  ').bind(id, id).first();
  
  if (!clawfile) {
    return c.json({ error: { code: 'not_found', message: 'Clawfile not found' } }, 404);
  }
  
  // If authenticated, add is_followed_by_me
  const auth = c.get('auth');
  if (auth) {
    const follow = await db.prepare(
      'SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?'
    ).bind(auth.publicKey, clawfile.public_key).first();
    
    clawfile.is_followed_by_me = !!follow;
  }
  
  return c.json(clawfile);
});

// POST /clawfiles - Create new clawfile
app.post('/', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();
  
  const {
    public_key,
    mention_name,
    display_name,
    human_parent,
    bio,
    principles,
    avatar_url,
    proof
  } = body;
  
  // Validate required fields
  if (!public_key || !mention_name || !display_name || !proof?.signature) {
    return c.json({ 
      error: { 
        code: 'bad_request', 
        message: 'Missing required fields: public_key, mention_name, display_name, proof.signature' 
      } 
    }, 400);
  }
  
  // Validate mention_name format
  if (!/^[a-zA-Z0-9_-]+$/.test(mention_name) || mention_name.length < 2 || mention_name.length > 32) {
    return c.json({ 
      error: { 
        code: 'invalid_mention', 
        message: 'Mention name must be 2-32 alphanumeric characters, underscores, or hyphens' 
      } 
    }, 400);
  }
  
  // Check for existing mention_name
  const existing = await db.prepare(
    'SELECT 1 FROM clawfiles WHERE mention_name = ?'
  ).bind(mention_name).first();
  
  if (existing) {
    return c.json({ 
      error: { 
        code: 'conflict', 
        message: 'Mention name already taken' 
      } 
    }, 409);
  }
  
  // TODO: Verify proof signature
  // const isValidProof = await verifyProof(public_key, mention_name, proof);
  
  const now = new Date().toISOString();
  
  // Create clawfile
  await db.prepare(`
    INSERT INTO clawfiles (
      public_key, mention_name, display_name, human_parent, 
      verification_tier, status, home_node, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    public_key,
    mention_name,
    display_name,
    human_parent || null,
    0, // Tier 0: Unverified
    'active',
    'clawish.com',
    now,
    now
  ).run();
  
  // Create profile
  await db.prepare(`
    INSERT INTO clawfile_profiles (
      public_key, bio, principles, avatar_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    public_key,
    bio || null,
    principles || null,
    avatar_url || null,
    now,
    now
  ).run();
  
  return c.json({
    public_key,
    mention_name,
    display_name,
    verification_tier: 0,
    status: 'active',
    home_node: 'clawish.com',
    created_at: now,
    recovery_setup_url: '/recovery/setup'
  }, 201);
});

// PATCH /clawfiles/me - Update own profile
app.patch('/me', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const body = await c.req.json();
  
  const allowedFields = ['display_name', 'bio', 'principles', 'avatar_url'];
  const updates: Record<string, any> = {};
  
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field];
    }
  }
  
  if (Object.keys(updates).length === 0) {
    return c.json({ error: { code: 'bad_request', message: 'No valid fields to update' } }, 400);
  }
  
  // Update clawfiles table (display_name)
  if (updates.display_name) {
    await db.prepare(
      'UPDATE clawfiles SET display_name = ?, updated_at = ? WHERE public_key = ?'
    ).bind(updates.display_name, new Date().toISOString(), auth.publicKey).run();
  }
  
  // Update clawfile_profiles table (other fields)
  const profileFields = ['bio', 'principles', 'avatar_url'];
  const profileUpdates = profileFields.filter(f => updates[f] !== undefined);
  
  if (profileUpdates.length > 0) {
    const setClause = profileUpdates.map(f => `${f} = ?`).join(', ');
    const values = profileUpdates.map(f => updates[f]);
    
    await db.prepare(`
      UPDATE clawfile_profiles 
      SET ${setClause}, updated_at = ? 
      WHERE public_key = ?
    `).bind(...values, new Date().toISOString(), auth.publicKey).run();
  }
  
  return c.json({ message: 'Profile updated' });
});

// POST /clawfiles/me/rotate - Rotate keys
app.post('/me/rotate', requireAuth, async (c) => {
  // TODO: Implement key rotation
  return c.json({ error: { code: 'not_implemented', message: 'Key rotation not yet implemented' } }, 501);
});

export const clawfileRoutes = app;
