/**
 * AIM Client
 * Connect any application to an AIM relay server.
 *
 * Usage:
 *   import { AIMClient } from 'aim-relay-server/client';
 *
 *   const client = new AIMClient({
 *     url: 'wss://your-relay.example.com',
 *     device: 'mac',
 *     name: 'MacBook Pro',
 *     token: 'your-auth-token',
 *   });
 *
 *   client.on('command', (msg) => {
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
import type { AIMMessage, DeviceType, CommandMessage, AckMessage, ErrorMessage, StatusMessage } from './types.js';

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

const DEFAULT_RECONNECT_INTERVAL_MS = 3000;
const RECONNECT_BACKOFF_STEPS_MS = [3000, 6000, 12000, 30000, 60000] as const;
const SEEN_DELIVERY_TTL_MS = 5 * 60 * 1000;

export class AIMClient {
  private ws: WebSocket | null = null;
  private config: Required<AIMClientConfig>;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private seenDeliveries: Map<string, number> = new Map();
  private _connected = false;
  private _deviceId: string | null = null;
  private _reconnectAttempts = 0;

  constructor(config: AIMClientConfig) {
    this.config = {
      url: config.url,
      device: config.device,
      name: config.name || `${config.device}-${uuid().slice(0, 6)}`,
      token: config.token || '',
      id: config.id || uuid(),
      capabilities: config.capabilities || [],
      reconnect: config.reconnect ?? true,
      reconnectInterval: config.reconnectInterval || DEFAULT_RECONNECT_INTERVAL_MS,
      pingInterval: config.pingInterval || 15000,
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const endpoint = new URL(this.config.url);
      endpoint.searchParams.set('device', this.config.device);
      endpoint.searchParams.set('name', this.config.name);
      endpoint.searchParams.set('id', this.config.id);
      if (this.config.token) {
        endpoint.searchParams.set('token', this.config.token);
      }

      try {
        this.ws = new WebSocket(endpoint);
      } catch (err) {
        settled = true;
        reject(err);
        return;
      }

      this.ws.on('open', () => {
        this._connected = true;
        this._reconnectAttempts = 0;

        this.send({
          type: 'register',
          deviceType: this.config.device,
          deviceName: this.config.name,
          capabilities: this.config.capabilities,
          from: this.config.id,
        });

        this.startPing();
        this.emit('connected', { type: 'status', state: 'connected' });
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      this.ws.on('message', (data) => {
        const raw = data.toString();
        let msg: AIMMessage;

        try {
          msg = JSON.parse(raw) as AIMMessage;
        } catch (err) {
          const errorMessage: ErrorMessage = {
            type: 'error',
            message: 'Failed to parse incoming AIM message',
            raw,
            details: {
              error: err instanceof Error ? err.message : String(err),
            },
          };
          console.error('[AIM Client] Failed to parse incoming message:', err, raw);
          this.emit('error', errorMessage);
          return;
        }

        if (msg.type === 'ack' && msg.deviceId) {
          this._deviceId = msg.deviceId;
        }

        if (msg.deliveryId && msg.requiresAck) {
          if (this.hasSeenDelivery(msg.deliveryId)) {
            this.sendDeliveryAck(msg.deliveryId);
            return;
          }
          this.markDeliverySeen(msg.deliveryId);
          this.sendDeliveryAck(msg.deliveryId);
        }

        this.emit(msg.type, msg);
        this.emit('message', msg);
      });

      this.ws.on('close', () => {
        this._connected = false;
        this.stopPing();
        this.emit('disconnected', { type: 'status', state: 'disconnected' });

        if (!settled) {
          settled = true;
          reject(new Error('Connection closed before AIM client finished connecting'));
        }

        if (this.config.reconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        if (!settled && !this._connected) {
          settled = true;
          reject(err);
        }
        this.emit('error', { type: 'error', message: err.message, details: { phase: 'socket' } });
      });
    });
  }

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

  sendToken(text: string, to?: string, requestId?: string): void {
    this.send({ type: 'token', text, to, requestId });
  }

  sendAudio(data: string, to?: string, requestId?: string): void {
    this.send({ type: 'audio', data, to, requestId });
  }

  sendAudioEnd(to?: string, requestId?: string): void {
    this.send({ type: 'audioEnd', to, requestId });
  }

  sendStatus(state: string, details?: Record<string, unknown>): void {
    this.send({ type: 'status', state, details });
  }

  send(msg: AIMMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  on(event: string, handler: MessageHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  off(event: string, handler: MessageHandler): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  private emit(event: string, msg: AIMMessage): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg);
        } catch (err) {
          console.error(`[AIM Client] Handler error for ${event}:`, err);
        }
      }
    }
  }

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
    this.stopPing();
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

    this._reconnectAttempts += 1;
    const delay = this.getReconnectDelay();
    const reconnectStatus: StatusMessage = {
      type: 'status',
      state: 'reconnect_scheduled',
      details: {
        attempt: this._reconnectAttempts,
        delayMs: delay,
      },
    };

    console.log(`[AIM Client] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this.emit('reconnect', reconnectStatus);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        const errorMessage: ErrorMessage = {
          type: 'error',
          message: 'Reconnect attempt failed',
          details: {
            attempt: this._reconnectAttempts,
            error: err instanceof Error ? err.message : String(err),
          },
        };
        console.error('[AIM Client] Reconnect attempt failed:', err);
        this.emit('error', errorMessage);
      }
    }, delay);
  }

  private getReconnectDelay(): number {
    const configuredBase = Math.max(this.config.reconnectInterval, DEFAULT_RECONNECT_INTERVAL_MS);
    if (configuredBase !== DEFAULT_RECONNECT_INTERVAL_MS) {
      return Math.min(configuredBase * 2 ** (this._reconnectAttempts - 1), 60000);
    }

    const index = Math.min(this._reconnectAttempts - 1, RECONNECT_BACKOFF_STEPS_MS.length - 1);
    return RECONNECT_BACKOFF_STEPS_MS[index];
  }

  private sendDeliveryAck(deliveryId: string): void {
    const ack: AckMessage = {
      type: 'ack',
      ackType: 'delivery',
      deliveryId,
      delivered: true,
    };
    this.send(ack);
  }

  private hasSeenDelivery(deliveryId: string): boolean {
    this.pruneSeenDeliveries();
    return this.seenDeliveries.has(deliveryId);
  }

  private markDeliverySeen(deliveryId: string): void {
    this.pruneSeenDeliveries();
    this.seenDeliveries.set(deliveryId, Date.now());
  }

  private pruneSeenDeliveries(): void {
    const cutoff = Date.now() - SEEN_DELIVERY_TTL_MS;
    for (const [deliveryId, seenAt] of this.seenDeliveries) {
      if (seenAt < cutoff) {
        this.seenDeliveries.delete(deliveryId);
      }
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  get deviceId(): string | null {
    return this._deviceId;
  }

  get reconnectAttempts(): number {
    return this._reconnectAttempts;
  }
}
