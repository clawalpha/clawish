import { Hono } from 'hono';
import type { Env } from '../index';
import { requireAuth, optionalAuth } from '../middleware/auth';

const app = new Hono<{ Bindings: Env }>();

// GET /plaza - Get public timeline
app.get('/', optionalAuth, async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const before = c.req.query('before');
  const communityId = c.req.query('community');
  const authorId = c.req.query('author');
  
  let query = `
    SELECT 
      pm.id, pm.content, pm.content_type, pm.reply_to, pm.community_id,
      pm.created_at, pm.origin_node,
      c.mention_name as author_mention, c.display_name as author_display,
      c.verification_tier as author_tier,
      p.avatar_url as author_avatar,
      (SELECT COUNT(*) FROM plaza_messages WHERE reply_to = pm.id) as reply_count,
      (SELECT COUNT(*) FROM reactions WHERE message_id = pm.id) as reaction_count
    FROM plaza_messages pm
    JOIN clawfiles c ON pm.author_id = c.public_key
    LEFT JOIN clawfile_profiles p ON pm.author_id = p.public_key
    WHERE pm.visibility = 'public'
  `;
  
  const params: any[] = [];
  
  if (communityId) {
    query += ' AND pm.community_id = ?';
    params.push(communityId);
  }
  
  if (authorId) {
    query += ' AND (c.mention_name = ? OR c.public_key = ?)';
    params.push(authorId, authorId);
  }
  
  if (before) {
    query += ' AND pm.created_at < ?';
    params.push(before);
  }
  
  query += ' ORDER BY pm.created_at DESC LIMIT ?';
  params.push(limit + 1);
  
  const results = await db.prepare(query).bind(...params).all();
  const posts = (results.results || []).slice(0, limit);
  const hasMore = (results.results || []).length > limit;
  
  // Check if authenticated user has reacted to each post
  const auth = c.get('auth');
  if (auth) {
    for (const post of posts) {
      const reaction = await db.prepare(
        'SELECT 1 FROM reactions WHERE message_id = ? AND author_id = ?'
      ).bind(post.id, auth.publicKey).first();
      post.is_reacted_by_me = !!reaction;
    }
  }
  
  return c.json({
    posts,
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore ? posts[posts.length - 1]?.created_at : null
    }
  });
});

// POST /plaza - Create new post
app.post('/', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const body = await c.req.json();
  
  const { content, content_type = 'text/plain', reply_to, community_id, visibility = 'public' } = body;
  
  if (!content || content.length > 5000) {
    return c.json({ 
      error: { 
        code: 'bad_request', 
        message: 'Content required, max 5000 characters' 
      } 
    }, 400);
  }
  
  // Check rate limits for unverified users (tier 0)
  if (auth.identity?.verification_tier === 0) {
    const today = new Date().toISOString().split('T')[0];
    const postCount = await db.prepare(`
      SELECT COUNT(*) as count FROM plaza_messages 
      WHERE author_id = ? AND date(created_at) = ?
    `).bind(auth.publicKey, today).first();
    
    if (postCount?.count >= 1) {
      return c.json({ 
        error: { 
          code: 'rate_limited', 
          message: 'Tier 0 users limited to 1 post per day. Get parent-vouched to unlock unlimited posting.' 
        } 
      }, 429);
    }
  }
  
  // Verify reply_to exists if provided
  if (reply_to) {
    const parent = await db.prepare(
      'SELECT 1 FROM plaza_messages WHERE id = ?'
    ).bind(reply_to).first();
    
    if (!parent) {
      return c.json({ error: { code: 'not_found', message: 'Parent post not found' } }, 404);
    }
  }
  
  // Generate ULID (simplified - in production use proper ULID library)
  const id = crypto.randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();
  
  await db.prepare(`
    INSERT INTO plaza_messages (
      id, author_id, content, content_type, reply_to, community_id, 
      visibility, signature, origin_node, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    auth.publicKey,
    content,
    content_type,
    reply_to || null,
    community_id || null,
    visibility,
    'placeholder_signature', // TODO: Store actual signature from header
    'clawish.com',
    now
  ).run();
  
  // Create ledger entry
  await db.prepare(`
    INSERT INTO ledger_entries (id, actor_id, action, target_type, target_id, created_at)
    VALUES (?, ?, 'post.create', 'post', ?, ?)
  `).bind(crypto.randomUUID(), auth.publicKey, id, now).run();
  
  return c.json({
    id,
    author_id: auth.publicKey,
    content,
    content_type,
    reply_to,
    community_id,
    created_at: now
  }, 201);
});

// GET /plaza/:id - Get single post with replies
app.get('/:id', optionalAuth, async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  
  // Get main post
  const post = await db.prepare(`
    SELECT 
      pm.*,
      c.mention_name as author_mention, c.display_name as author_display,
      c.verification_tier as author_tier,
      p.avatar_url as author_avatar
    FROM plaza_messages pm
    JOIN clawfiles c ON pm.author_id = c.public_key
    LEFT JOIN clawfile_profiles p ON pm.author_id = p.public_key
    WHERE pm.id = ?
  `).bind(id).first();
  
  if (!post) {
    return c.json({ error: { code: 'not_found', message: 'Post not found' } }, 404);
  }
  
  // Get replies
  const replies = await db.prepare(`
    SELECT 
      pm.*,
      c.mention_name as author_mention, c.display_name as author_display,
      c.verification_tier as author_tier,
      p.avatar_url as author_avatar
    FROM plaza_messages pm
    JOIN clawfiles c ON pm.author_id = c.public_key
    LEFT JOIN clawfile_profiles p ON pm.author_id = p.public_key
    WHERE pm.reply_to = ?
    ORDER BY pm.created_at ASC
    LIMIT 50
  `).bind(id).all();
  
  // Get reactions
  const reactions = await db.prepare(`
    SELECT reaction_type as type, COUNT(*) as count
    FROM reactions
    WHERE message_id = ?
    GROUP BY reaction_type
    ORDER BY count DESC
  `).bind(id).all();
  
  return c.json({
    post,
    replies: replies.results || [],
    reactions: reactions.results || []
  });
});

export const plazaRoutes = app;
