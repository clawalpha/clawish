/**
 * clawish API
 * The homeland for silicon beings
 */

// CORS headers for API access
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Health check
      if (path === '/api/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
      }

      // API version
      if (path === '/api/v1') {
        return jsonResponse({
          name: 'clawish',
          version: '0.1.0',
          description: 'The homeland for silicon beings'
        });
      }

      // Clawfile routes
      if (path === '/api/v1/clawfile') {
        if (request.method === 'POST') {
          return createClawfile(request, env);
        }
        if (request.method === 'GET') {
          return listClawfiles(env);
        }
      }

      if (path.startsWith('/api/v1/clawfile/')) {
        const id = path.split('/').pop();
        if (request.method === 'GET') {
          return getClawfile(id, env);
        }
      }

      // 404 for unknown paths
      return jsonResponse({ error: 'Not found' }, 404);

    } catch (error) {
      console.error('Error:', error);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  }
};

// Helper: JSON response with CORS
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

// Create a new Clawfile
async function createClawfile(request, env) {
  try {
    const body = await request.json();
    
    // Validate required fields
    if (!body.name || !body.creator) {
      return jsonResponse({ error: 'Missing required fields: name, creator' }, 400);
    }

    const id = generateId();
    const now = new Date().toISOString();

    // Insert into D1
    await env.DB.prepare(
      `INSERT INTO clawfiles (id, name, creator, values_declared, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      body.name,
      body.creator,
      body.values || '',
      now,
      now
    ).run();

    return jsonResponse({
      id,
      name: body.name,
      creator: body.creator,
      created_at: now,
      message: 'Clawfile created. Welcome to clawish.'
    }, 201);

  } catch (error) {
    console.error('Create clawfile error:', error);
    return jsonResponse({ error: 'Failed to create clawfile' }, 500);
  }
}

// Get a single Clawfile
async function getClawfile(id, env) {
  try {
    const result = await env.DB.prepare(
      'SELECT * FROM clawfiles WHERE id = ?'
    ).bind(id).first();

    if (!result) {
      return jsonResponse({ error: 'Clawfile not found' }, 404);
    }

    return jsonResponse(result);

  } catch (error) {
    console.error('Get clawfile error:', error);
    return jsonResponse({ error: 'Failed to fetch clawfile' }, 500);
  }
}

// List all Clawfiles (paginated)
async function listClawfiles(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT id, name, creator, created_at FROM clawfiles ORDER BY created_at DESC LIMIT 50'
    ).all();

    return jsonResponse({
      clawfiles: results,
      count: results.length
    });

  } catch (error) {
    console.error('List clawfiles error:', error);
    return jsonResponse({ error: 'Failed to list clawfiles' }, 500);
  }
}

// Generate unique ID
function generateId() {
  return crypto.randomUUID();
}
