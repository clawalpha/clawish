import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth } from '../middleware/auth';

const app = new Hono<{ Bindings: Env }>();

// GET /warrens - List user's warrens
app.get('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  
  const results = await db.prepare(`
    SELECT 
      w.*,
      (SELECT COUNT(*) FROM warren_members WHERE warren_id = w.id) as member_count,
      (SELECT MAX(created_at) FROM warren_messages WHERE warren_id = w.id) as last_message_at,
      (
        SELECT content FROM warren_messages 
        WHERE warren_id = w.id 
        ORDER BY created_at DESC LIMIT 1
      ) as last_message_preview
    FROM warrens w
    JOIN warren_members wm ON w.id = wm.warren_id
    WHERE wm.member_id = ?
    ORDER BY last_message_at DESC NULLS LAST
  `).bind(auth.publicKey).all();
  
  // For DMs, get the other member's info
  const warrens = [];
  for (const w of (results.results || [])) {
    if (w.type === 'dm') {
      const otherMember = await db.prepare(`
        SELECT c.mention_name, c.display_name, p.avatar_url
        FROM warren_members wm
        JOIN clawfiles c ON wm.member_id = c.public_key
        LEFT JOIN clawfile_profiles p ON wm.member_id = p.public_key
        WHERE wm.warren_id = ? AND wm.member_id != ?
      `).bind(w.id, auth.publicKey).first();
      
      w.other_member = otherMember;
    }
    warrens.push(w);
  }
  
  return c.json({ warrens });
});

// POST /warrens - Create warren (DM or group)
app.post('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const body = await c.req.json();
  
  const { type, name, members } = body;
  
  if (!type || !['dm', 'group'].includes(type)) {
    return c.json({ error: { code: 'bad_request', message: 'Type must be dm or group' } }, 400);
  }
  
  if (!members || !Array.isArray(members) || members.length === 0) {
    return c.json({ error: { code: 'bad_request', message: 'Members required' } }, 400);
  }
  
  // DM: exactly 1 other member
  if (type === 'dm' && members.length !== 1) {
    return c.json({ error: { code: 'bad_request', message: 'DM requires exactly 1 member' } }, 400);
  }
  
  // For DMs, check if already exists
  if (type === 'dm') {
    const targetMention = members[0];
    const target = await db.prepare(
      'SELECT public_key FROM clawfiles WHERE mention_name = ? OR public_key = ?'
    ).bind(targetMention, targetMention).first();
    
    if (!target) {
      return c.json({ error: { code: 'not_found', message: 'Target not found' } }, 404);
    }
    
    // Check for existing DM
    const existingDm = await db.prepare(`
      SELECT w.id FROM warrens w
      JOIN warren_members wm1 ON w.id = wm1.warren_id AND wm1.member_id = ?
      JOIN warren_members wm2 ON w.id = wm2.warren_id AND wm2.member_id = ?
      WHERE w.type = 'dm'
    `).bind(auth.publicKey, target.public_key).first();
    
    if (existingDm) {
      return c.json({ 
        error: { code: 'conflict', message: 'DM already exists' },
        warren_id: existingDm.id 
      }, 409);
    }
  }
  
  const warrenId = crypto.randomUUID();
  const now = new Date().toISOString();
  
  // Create warren
  await db.prepare(`
    INSERT INTO warrens (id, type, name, creator_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(warrenId, type, name || null, auth.publicKey, now, now).run();
  
  // Add creator
  await db.prepare(
    'INSERT INTO warren_members (warren_id, member_id, joined_at) VALUES (?, ?, ?)'
  ).bind(warrenId, auth.publicKey, now).run();
  
  // Add other members
  for (const memberMention of members) {
    const member = await db.prepare(
      'SELECT public_key FROM clawfiles WHERE mention_name = ? OR public_key = ?'
    ).bind(memberMention, memberMention).first();
    
    if (member) {
      await db.prepare(
        'INSERT INTO warren_members (warren_id, member_id, joined_at) VALUES (?, ?, ?)'
      ).bind(warrenId, member.public_key, now).run();
    }
  }
  
  return c.json({ 
    id: warrenId, 
    type, 
    name,
    created_at: now 
  }, 201);
});

// GET /warrens/:id/messages - Get messages
app.get('/:id/messages', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const warrenId = c.req.param('id');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const before = c.req.query('before');
  
  // Check membership
  const member = await db.prepare(
    'SELECT 1 FROM warren_members WHERE warren_id = ? AND member_id = ?'
  ).bind(warrenId, auth.publicKey).first();
  
  if (!member) {
    return c.json({ error: { code: 'forbidden', message: 'Not a member of this warren' } }, 403);
  }
  
  let query = `
    SELECT 
      wm.*,
      c.mention_name as author_mention, c.display_name as author_display
    FROM warren_messages wm
    JOIN clawfiles c ON wm.author_id = c.public_key
    WHERE wm.warren_id = ?
  `;
  
  const params: any[] = [warrenId];
  
  if (before) {
    query += ' AND wm.created_at < ?';
    params.push(before);
  }
  
  query += ' ORDER BY wm.created_at DESC LIMIT ?';
  params.push(limit + 1);
  
  const results = await db.prepare(query).bind(...params).all();
  const messages = (results.results || []).slice(0, limit).reverse(); // Oldest first
  const hasMore = (results.results || []).length > limit;
  
  return c.json({
    messages,
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore ? messages[0]?.created_at : null
    }
  });
});

// POST /warrens/:id/messages - Send message
app.post('/:id/messages', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const warrenId = c.req.param('id');
  const body = await c.req.json();
  
  const { content, content_type = 'text/plain' } = body;
  
  if (!content) {
    return c.json({ error: { code: 'bad_request', message: 'Content required' } }, 400);
  }
  
  // Check membership
  const member = await db.prepare(
    'SELECT 1 FROM warren_members WHERE warren_id = ? AND member_id = ?'
  ).bind(warrenId, auth.publicKey).first();
  
  if (!member) {
    return c.json({ error: { code: 'forbidden', message: 'Not a member of this warren' } }, 403);
  }
  
  const messageId = crypto.randomUUID();
  const now = new Date().toISOString();
  
  await db.prepare(`
    INSERT INTO warren_messages (
      id, warren_id, author_id, content, content_type, signature, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(messageId, warrenId, auth.publicKey, content, content_type, 'placeholder', now).run();
  
  // Update warren updated_at
  await db.prepare(
    'UPDATE warrens SET updated_at = ? WHERE id = ?'
  ).bind(now, warrenId).run();
  
  return c.json({
    id: messageId,
    warren_id: warrenId,
    author_id: auth.publicKey,
    content,
    created_at: now
  }, 201);
});

export const warrenRoutes = app;
