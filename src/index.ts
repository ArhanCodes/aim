#!/usr/bin/env node
/**
 * AIM - Advanced Idea Mechanics
 * Real-time WebSocket relay for AI assistants.
 *
 * Usage:
 *   aim                    # Start with defaults (port 5225)
 *   AIM_PORT=8080 aim      # Custom port
 *   AIM_AUTH_TOKEN=xxx aim  # Enable authentication
 *
 * Clients connect via:
 *   ws://host:5225?device=mac&name=MacBook
 *   ws://host:5225?device=phone&name=iPhone&token=xxx
 */

import { config } from 'dotenv';
import { AIMServer } from './server.js';

// Load .env
config();

const server = new AIMServer({
  port: parseInt(process.env.AIM_PORT || '5225'),
  authToken: process.env.AIM_AUTH_TOKEN || undefined,
  allowedOrigins: process.env.AIM_ALLOWED_ORIGINS?.split(',').filter(Boolean),
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[AIM] Shutting down...');
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});

// Start
server.start().catch((err) => {
  console.error('[AIM] Failed to start:', err);
  process.exit(1);
});

// Export for programmatic use
export { AIMServer } from './server.js';
export { AIMRelay } from './relay.js';
export type * from './types.js';
