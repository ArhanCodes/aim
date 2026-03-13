/**
 * AIM WebSocket Server
 * Handles connections, authentication, and protocol upgrades.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { AIMRelay } from './relay.js';
import type { AIMConfig, RegisterMessage } from './types.js';

export class AIMServer {
  private wss: WebSocketServer | null = null;
  public relay: AIMRelay;
  private config: AIMConfig;

  constructor(config: Partial<AIMConfig> = {}) {
    this.config = {
      port: config.port || 5225,
      authToken: config.authToken,
      allowedOrigins: config.allowedOrigins,
      heartbeatInterval: config.heartbeatInterval || 30000,
      maxMessageSize: config.maxMessageSize || 10 * 1024 * 1024, // 10MB for audio
    };

    this.relay = new AIMRelay(this.config.heartbeatInterval);
  }

  /**
   * Start the AIM server.
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({
        port: this.config.port,
        maxPayload: this.config.maxMessageSize,
        verifyClient: (info, callback) => {
          // Auth check
          if (this.config.authToken) {
            const url = new URL(info.req.url || '', `http://localhost`);
            const token = url.searchParams.get('token') ||
              info.req.headers['x-aim-token'] as string ||
              this.extractBearerToken(info.req);

            if (token !== this.config.authToken) {
              callback(false, 401, 'Unauthorized');
              return;
            }
          }

          // Origin check
          if (this.config.allowedOrigins && this.config.allowedOrigins.length > 0) {
            const origin = info.origin || info.req.headers.origin;
            if (origin && !this.config.allowedOrigins.includes(origin)) {
              callback(false, 403, 'Origin not allowed');
              return;
            }
          }

          callback(true);
        },
      });

      this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        this.handleConnection(ws, req);
      });

      this.wss.on('listening', () => {
        console.log(`\n  ╔══════════════════════════════════════╗`);
        console.log(`  ║      AIM Relay Server v1.0.0         ║`);
        console.log(`  ║   Advanced Idea Mechanics            ║`);
        console.log(`  ╠══════════════════════════════════════╣`);
        console.log(`  ║  Port: ${String(this.config.port).padEnd(30)}║`);
        console.log(`  ║  Auth: ${(this.config.authToken ? 'Enabled' : 'Disabled').padEnd(30)}║`);
        console.log(`  ╚══════════════════════════════════════╝\n`);

        this.relay.startHeartbeat();
        resolve();
      });

      this.wss.on('error', (err) => {
        console.error(`[AIM] Server error:`, err.message);
      });
    });
  }

  /**
   * Handle a new WebSocket connection.
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || '', 'http://localhost');
    const deviceType = url.searchParams.get('device') || 'custom';
    const deviceName = url.searchParams.get('name') || undefined;
    const deviceId = url.searchParams.get('id') || undefined;

    // Auto-register with URL params (or wait for register message)
    const regMsg: RegisterMessage = {
      type: 'register',
      deviceType: deviceType as any,
      deviceName,
      from: deviceId,
      capabilities: [],
    };

    const id = this.relay.registerDevice(ws, regMsg);

    ws.on('message', (data) => {
      try {
        const raw = data.toString();

        // Check if this is a register message (re-registration with capabilities)
        const parsed = JSON.parse(raw);
        if (parsed.type === 'register') {
          // Re-register with full capabilities
          this.relay.registerDevice(ws, parsed as RegisterMessage);
          return;
        }

        this.relay.handleMessage(id, raw);
      } catch (err) {
        console.error(`[AIM] Message error from ${id}:`, err);
      }
    });

    ws.on('close', () => {
      this.relay.removeDevice(id);
    });

    ws.on('error', (err) => {
      console.error(`[AIM] WebSocket error for ${id}:`, err.message);
    });

    ws.on('pong', () => {
      // Update last seen on pong
      const device = this.relay.getDevice(id);
      if (device) device.lastSeen = Date.now();
    });
  }

  /**
   * Extract Bearer token from Authorization header.
   */
  private extractBearerToken(req: IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    return null;
  }

  /**
   * Stop the server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.relay.stopHeartbeat();
      if (this.wss) {
        this.wss.close(() => {
          console.log('[AIM] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
