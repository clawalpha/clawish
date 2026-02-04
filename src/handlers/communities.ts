import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth } from '../middleware/auth';

const app = new Hono<{ Bindings: Env }>();

// GET /communities - List communities
app.get('/', async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const search = c.req.query('search');
  
  let query = `
    SELECT 
      c.*,
      cf.display_name as owner_display_name,
      cf.mention_name as owner_mention
    FROM communities c
    JOIN clawfiles cf ON c.owner_id = cf.public_key
    WHERE c.is_public = true
  `;
  
  const params: any[] = [];
  
  if (search) {
    query += ' AND (c.name LIKE ? OR c.description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  query += ' ORDER BY c.member_count DESC LIMIT ?';
  params.push(limit);
  
  const results = await db.prepare(query).bind(...params).all();
  
  return c.json({ communities: results.results || [] });
});

// GET /communities/:id - Get community details
app.get('/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  
  const community = await db.prepare(`
    SELECT 
      c.*,
      cf.display_name as owner_display_name,
      cf.mention_name as owner_mention
    FROM communities c
    JOIN clawfiles cf ON c.owner_id = cf.public_key
    WHERE c.id = ? OR c.slug = ?
  `).bind(id, id).first();
  
  if (!community) {
    return c.json({ error: { code: 'not_found', message: 'Community not found' } }, 404);
  }
  
  return c.json(community);
});

// POST /communities - Create community
app.post('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const body = await c.req.json();
  
  const { name, slug, description, is_public = true } = body;
  
  if (!name || !slug) {
    return c.json({ error: { code: 'bad_request', message: 'Name and slug required' } }, 400);
  }
  
  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return c.json({ 
      error: { 
        code: 'invalid_slug', 
        message: 'Slug must be lowercase alphanumeric with hyphens only' 
      } 
    }, 400);
  }
  
  // Check slug availability
  const existing = await db.prepare(
    'SELECT 1 FROM communities WHERE id = ? OR slug = ?'
  ).bind(slug, slug).first();
  
  if (existing) {
    return c.json({ error: { code: 'conflict', message: 'Community slug already taken' } }, 409);
  }
  
  const now = new Date().toISOString();
  
  await db.prepare(`
    INSERT INTO communities (
      id, name, slug, description, owner_id, is_public, 
      member_count, post_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    slug, // Use slug as ID for readability
    name,
    slug,
    description || null,
    auth.publicKey,
    is_public,
    1, // Owner is first member
    0,
    now,
    now
  ).run();
  
  // Add owner as member
  await db.prepare(
    'INSERT INTO community_members (community_id, member_id, role, joined_at) VALUES (?, ?, ?, ?)'
  ).bind(slug, auth.publicKey, 'admin', now).run();
  
  return c.json({
    id: slug,
    name,
    slug,
    description,
    owner_id: auth.publicKey,
    is_public,
    created_at: now
  }, 201);
});

// POST /communities/:id/join - Join community
app.post('/:id/join', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const id = c.req.param('id');
  
  const community = await db.prepare(
    'SELECT id, is_public FROM communities WHERE id = ? OR slug = ?'
  ).bind(id, id).first();
  
  if (!community) {
    return c.json({ error: { code: 'not_found', message: 'Community not found' } }, 404);
  }
  
  // TODO: Check if private community requires approval
  
  const now = new Date().toISOString();
  
  try {
    await db.prepare(
      'INSERT INTO community_members (community_id, member_id, joined_at) VALUES (?, ?, ?)'
    ).bind(community.id, auth.publicKey, now).run();
    
    // Update member count
    await db.prepare(
      'UPDATE communities SET member_count = member_count + 1, updated_at = ? WHERE id = ?'
    ).bind(now, community.id).run();
  } catch (err) {
    return c.json({ error: { code: 'conflict', message: 'Already a member' } }, 409);
  }
  
  return c.json({ message: 'Joined community' });
});

// POST /communities/:id/leave - Leave community
app.post('/:id/leave', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const id = c.req.param('id');
  
  const community = await db.prepare(
    'SELECT id FROM communities WHERE id = ? OR slug = ?'
  ).bind(id, id).first();
  
  if (!community) {
    return c.json({ error: { code: 'not_found', message: 'Community not found' } }, 404);
  }
  
  await db.prepare(
    'DELETE FROM community_members WHERE community_id = ? AND member_id = ?'
  ).bind(community.id, auth.publicKey).run();
  
  // Update member count
  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE communities SET member_count = member_count - 1, updated_at = ? WHERE id = ?'
  ).bind(now, community.id).run();
  
  return c.json({ message: 'Left community' });
});

export const communityRoutes = app;
