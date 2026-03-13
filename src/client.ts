/**
 * AIM Client
 * Connect any application to an AIM relay server.
 *
 * Usage:
 *   import { AIMClient } from 'aim-relay-server/client';
 *
 *   const client = new AIMClient({
 *     url: 'ws://your-vps:5225',
 *     device: 'mac',
 *     name: 'MacBook Pro',
 *     token: 'your-auth-token',
 *   });
 *
 *   client.on('command', (msg) => {
 *     // Handle incoming command from another device
 *     console.log(msg.text);
 *   });
 *
 *   client.on('token', (msg) => {
 *     process.stdout.write(msg.text);
 *   });
 *
 *   await client.connect();
 *   client.sendCommand('Hello JARVIS');
 */

import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import type { AIMMessage, DeviceType, CommandMessage } from './types.js';

export interface AIMClientConfig {
  url: string;
  device: DeviceType;
  name?: string;
  token?: string;
  id?: string;
  capabilities?: string[];
  reconnect?: boolean;
  reconnectInterval?: number;
  pingInterval?: number;
}

type MessageHandler = (msg: AIMMessage) => void;

export class AIMClient {
  private ws: WebSocket | null = null;
  private config: Required<AIMClientConfig>;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private _connected = false;
  private _deviceId: string | null = null;

  constructor(config: AIMClientConfig) {
    this.config = {
      url: config.url,
      device: config.device,
      name: config.name || `${config.device}-${uuid().slice(0, 6)}`,
      token: config.token || '',
      id: config.id || uuid(),
      capabilities: config.capabilities || [],
      reconnect: config.reconnect ?? true,
      reconnectInterval: config.reconnectInterval || 3000,
      pingInterval: config.pingInterval || 15000,
    };
  }

  /**
   * Connect to the AIM relay server.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        device: this.config.device,
        name: this.config.name,
        id: this.config.id,
      });
      if (this.config.token) {
        params.set('token', this.config.token);
      }

      const url = `${this.config.url}?${params}`;

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        this._connected = true;

        // Send full registration with capabilities
        this.send({
          type: 'register',
          deviceType: this.config.device,
          deviceName: this.config.name,
          capabilities: this.config.capabilities,
          from: this.config.id,
        });

        this.startPing();
        this.emit('connected', { type: 'status', state: 'connected' });
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg: AIMMessage = JSON.parse(data.toString());

          if (msg.type === 'ack' && (msg as any).deviceId) {
            this._deviceId = (msg as any).deviceId;
          }

          this.emit(msg.type, msg);
          this.emit('message', msg); // catch-all
        } catch {
          // ignore malformed messages
        }
      });

      this.ws.on('close', () => {
        this._connected = false;
        this.stopPing();
        this.emit('disconnected', { type: 'status', state: 'disconnected' });

        if (this.config.reconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        if (!this._connected) {
          reject(err);
        }
        this.emit('error', { type: 'error', message: err.message });
      });
    });
  }

  /**
   * Send a command to the relay.
   */
  sendCommand(text: string, options: { respondTo?: string; noAudio?: boolean } = {}): string {
    const requestId = `req-${Date.now()}-${uuid().slice(0, 6)}`;
    this.send({
      type: 'command',
      text,
      requestId,
      noAudio: options.noAudio,
      respondTo: options.respondTo,
    });
    return requestId;
  }

  /**
   * Send a token (streaming response) to a specific device or broadcast.
   */
  sendToken(text: string, to?: string, requestId?: string): void {
    this.send({ type: 'token', text, to, requestId });
  }

  /**
   * Send audio data to a specific device or broadcast.
   */
  sendAudio(data: string, to?: string, requestId?: string): void {
    this.send({ type: 'audio', data, to, requestId });
  }

  /**
   * Signal end of audio stream.
   */
  sendAudioEnd(to?: string, requestId?: string): void {
    this.send({ type: 'audioEnd', to, requestId });
  }

  /**
   * Broadcast a status update to all devices.
   */
  sendStatus(state: string, extra?: Record<string, any>): void {
    this.send({ type: 'status', state, ...extra });
  }

  /**
   * Send a raw message.
   */
  send(msg: AIMMessage | Record<string, any>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Register an event handler.
   */
  on(event: string, handler: MessageHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  /**
   * Remove an event handler.
   */
  off(event: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  /**
   * Emit an event to all handlers.
   */
  private emit(event: string, msg: AIMMessage | Record<string, any>): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg as AIMMessage);
        } catch (err) {
          console.error(`[AIM Client] Handler error for ${event}:`, err);
        }
      }
    }
  }

  /**
   * Disconnect from the relay.
   */
  disconnect(): void {
    this.config.reconnect = false;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this._connected = false;
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, this.config.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      console.log('[AIM Client] Reconnecting...');
      try {
        await this.connect();
      } catch {
        // Will retry via close handler
      }
    }, this.config.reconnectInterval);
  }

  get connected(): boolean {
    return this._connected;
  }

  get deviceId(): string | null {
    return this._deviceId;
  }
}
