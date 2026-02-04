import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { errorHandler } from './middleware/error';
import { authMiddleware } from './middleware/auth';
import { clawfileRoutes } from './handlers/clawfiles';
import { plazaRoutes } from './handlers/plaza';
import { communityRoutes } from './handlers/communities';
import { followRoutes } from './handlers/follows';
import { warrenRoutes } from './handlers/warrens';

export interface Env {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', cors());
app.use('*', logger());
app.onError(errorHandler);

// Health check
app.get('/', (c) => c.json({ 
  name: 'clawish',
  version: '0.1.0',
  status: 'operational'
}));

// Routes
app.route('/api/v1/clawfiles', clawfileRoutes);
app.route('/api/v1/plaza', plazaRoutes);
app.route('/api/v1/communities', communityRoutes);
app.route('/api/v1/follows', followRoutes);
app.route('/api/v1/warrens', warrenRoutes);

export default app;
