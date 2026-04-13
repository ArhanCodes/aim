/**
 * AIM Relay - Core relay engine.
 * Routes messages between connected devices.
 * Manages device registration, heartbeats, and message routing.
 */

import { WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import type {
  AIMMessage,
  RegisterMessage,
  CommandMessage,
  ConnectedDevice,
  AckMessage,
  ErrorMessage,
} from './types.js';

interface DeviceConnection {
  ws: WebSocket;
  device: ConnectedDevice;
}

type CommandHandler = (msg: CommandMessage, from: ConnectedDevice) => void;

interface RelayResilienceConfig {
  offlineMessageTtlMs: number;
  retryBaseMs: number;
  retryCapMs: number;
  ackTimeoutMs: number;
}

interface PendingDelivery {
  targetHints: string[];
  message: AIMMessage;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  requireAck: boolean;
  retryTimer: NodeJS.Timeout | null;
  ackTimer: NodeJS.Timeout | null;
  awaitingAck: boolean;
}

const DEFAULT_RESILIENCE_CONFIG: RelayResilienceConfig = {
  offlineMessageTtlMs: 60000,
  retryBaseMs: 1000,
  retryCapMs: 30000,
  ackTimeoutMs: 5000,
};

const CRITICAL_MESSAGE_TYPES = new Set<AIMMessage['type']>([
  'command',
  'response',
  'status',
  'error',
  'system_command',
  'system_command_result',
  'play_audio',
]);

export class AIMRelay {
  private devices: Map<string, DeviceConnection> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private commandHandlers: CommandHandler[] = [];
  private pendingDeliveries: Map<string, PendingDelivery> = new Map();
  private resilienceConfig: RelayResilienceConfig;

  constructor(
    private heartbeatMs: number = 30000,
    resilienceConfig: Partial<RelayResilienceConfig> = {},
  ) {
    this.resilienceConfig = {
      ...DEFAULT_RESILIENCE_CONFIG,
      ...resilienceConfig,
    };
  }

  onCommand(handler: CommandHandler): void {
    this.commandHandlers.push(handler);
  }

  offCommand(handler: CommandHandler): void {
    const index = this.commandHandlers.indexOf(handler);
    if (index >= 0) {
      this.commandHandlers.splice(index, 1);
    }
  }

  registerDevice(ws: WebSocket, msg: RegisterMessage): string {
    const id = msg.from || uuid();
    const device: ConnectedDevice = {
      id,
      deviceType: msg.deviceType || 'custom',
      deviceName: msg.deviceName || `${msg.deviceType}-${id.slice(0, 6)}`,
      capabilities: msg.capabilities || [],
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    };

    const existing = this.devices.get(id);
    if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(1000, 'Replaced by new connection');
    }

    this.devices.set(id, { ws, device });

    this.send(ws, {
      type: 'ack',
      ackType: 'register',
      deviceId: id,
      message: `Registered as ${device.deviceName}`,
      connectedDevices: this.getDeviceList(),
    });

    this.broadcast({
      type: 'status',
      state: 'device_connected',
      device: { id, deviceType: device.deviceType, deviceName: device.deviceName },
      connectedDevices: this.getDeviceList(),
    }, id);

    this.flushPendingDeliveriesFor(device);
    console.log(`[AIM] Device registered: ${device.deviceName} (${device.deviceType}) [${id}]`);
    return id;
  }

  handleMessage(deviceId: string, raw: string): void {
    const conn = this.devices.get(deviceId);
    if (!conn) return;

    conn.device.lastSeen = Date.now();

    let msg: AIMMessage;
    try {
      msg = JSON.parse(raw) as AIMMessage;
    } catch {
      this.send(conn.ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    msg = {
      ...msg,
      from: deviceId,
      timestamp: msg.timestamp || Date.now(),
    };

    switch (msg.type) {
      case 'ping':
        this.send(conn.ws, { type: 'pong' });
        break;

      case 'ack':
        this.handleAck(msg);
        break;

      case 'command':
        this.handleCommand(msg, conn.device);
        break;

      case 'token':
      case 'response':
      case 'audio':
      case 'audioEnd':
      case 'error':
        if (msg.to) {
          this.sendToDevice(msg.to, msg);
        } else {
          this.broadcast(msg, deviceId);
        }
        break;

      case 'status':
        this.broadcast(msg);
        break;

      case 'route':
        this.sendToDevice(msg.to, msg);
        break;

      case 'broadcast':
        this.broadcast(msg, deviceId);
        break;

      case 'devices':
        this.send(conn.ws, {
          type: 'devices',
          devices: this.getDeviceList(),
        });
        break;

      default:
        if (msg.to) {
          this.sendToDevice(msg.to, msg);
        } else {
          this.broadcast(msg, deviceId);
        }
    }
  }

  private handleCommand(msg: CommandMessage, from: ConnectedDevice): void {
    console.log(`[AIM] Command from ${from.deviceName}: "${msg.text}"`);

    if (!msg.respondTo) {
      msg.respondTo = from.id;
    }

    if (this.commandHandlers.length > 0) {
      for (const handler of this.commandHandlers) {
        try {
          handler(msg, from);
        } catch (err) {
          console.error('[AIM] Command handler error:', err);
        }
      }
      return;
    }

    const backend = this.findBackend();
    if (backend) {
      this.sendToDevice(backend.device.id, msg);
      return;
    }

    this.sendToPreferredTargets(['server', 'mac', 'cli'], msg);
  }

  private findBackend(): DeviceConnection | null {
    let macConn: DeviceConnection | null = null;
    for (const [, conn] of this.devices) {
      if (conn.device.deviceType === 'server') {
        return conn;
      }
      if (conn.device.deviceType === 'mac' || conn.device.deviceType === 'cli') {
        macConn = conn;
      }
    }
    return macConn;
  }

  sendResponse(msg: AIMMessage, respondTo?: string): void {
    if (respondTo) {
      this.sendToDevice(respondTo, msg);
    } else {
      this.broadcast(msg);
    }
  }

  sendToDevice(target: string, msg: AIMMessage): boolean {
    return this.sendToPreferredTargets([target], msg);
  }

  broadcast(msg: AIMMessage, excludeId?: string): void {
    const data = JSON.stringify(msg);
    for (const [id, conn] of this.devices) {
      if (id !== excludeId && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(data);
      }
    }
  }

  removeDevice(deviceId: string): void {
    const conn = this.devices.get(deviceId);
    if (conn) {
      console.log(`[AIM] Device disconnected: ${conn.device.deviceName} [${deviceId}]`);
      this.devices.delete(deviceId);

      this.broadcast({
        type: 'status',
        state: 'device_disconnected',
        device: { id: deviceId, deviceType: conn.device.deviceType, deviceName: conn.device.deviceName },
        connectedDevices: this.getDeviceList(),
      });
    }
  }

  getDeviceList(): Array<Pick<ConnectedDevice, 'id' | 'deviceType' | 'deviceName' | 'capabilities'>> {
    return Array.from(this.devices.values()).map(c => ({
      id: c.device.id,
      deviceType: c.device.deviceType,
      deviceName: c.device.deviceName,
      capabilities: c.device.capabilities,
    }));
  }

  getDevice(id: string): ConnectedDevice | null {
    return this.devices.get(id)?.device || null;
  }

  startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of this.devices) {
        if (now - conn.device.lastSeen > this.heartbeatMs * 3) {
          console.log(`[AIM] Heartbeat timeout: ${conn.device.deviceName}`);
          conn.ws.terminate();
          this.removeDevice(id);
        } else if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.ping();
        }
      }
    }, this.heartbeatMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const deliveryId of this.pendingDeliveries.keys()) {
      this.clearPendingDelivery(deliveryId);
    }
  }

  private handleAck(msg: AckMessage): void {
    if (msg.ackType === 'delivery' && msg.deliveryId) {
      this.clearPendingDelivery(msg.deliveryId);
    }
  }

  private sendToPreferredTargets(targetHints: string[], msg: AIMMessage): boolean {
    const requireAck = this.requiresDeliveryAck(msg);
    const preparedMessage = this.prepareOutgoingMessage(msg, requireAck);
    const targetConn = this.resolveDeviceConnection(targetHints);

    if (!targetConn) {
      this.queueDelivery(targetHints, preparedMessage, requireAck);
      return false;
    }

    return this.deliverToConnection(targetHints, targetConn, preparedMessage, requireAck);
  }

  private deliverToConnection(
    targetHints: string[],
    conn: DeviceConnection,
    msg: AIMMessage,
    requireAck: boolean,
  ): boolean {
    const deliveryId = msg.deliveryId;
    const sendSucceeded = this.send(conn.ws, msg, (err) => {
      console.error(`[AIM] Failed to send ${msg.type} to ${conn.device.deviceName}:`, err.message);
      if (deliveryId) {
        this.scheduleRetry(deliveryId);
      } else {
        this.queueDelivery(targetHints, msg, requireAck);
      }
    });

    if (!sendSucceeded) {
      this.queueDelivery(targetHints, msg, requireAck);
      return false;
    }

    if (requireAck) {
      this.trackPendingAck(targetHints, msg);
    } else if (deliveryId) {
      this.clearPendingDelivery(deliveryId);
    }

    return true;
  }

  private queueDelivery(targetHints: string[], msg: AIMMessage, requireAck: boolean): void {
    const deliveryId = msg.deliveryId || `delivery-${uuid()}`;
    const existing = this.pendingDeliveries.get(deliveryId);
    const message = this.prepareOutgoingMessage({ ...msg, deliveryId }, requireAck);

    if (existing) {
      existing.targetHints = targetHints;
      existing.message = message;
      existing.requireAck = requireAck;
      existing.awaitingAck = false;
      if (existing.ackTimer) {
        clearTimeout(existing.ackTimer);
        existing.ackTimer = null;
      }
      this.scheduleRetry(deliveryId);
      return;
    }

    const pending: PendingDelivery = {
      targetHints,
      message,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.resilienceConfig.offlineMessageTtlMs,
      attempts: 0,
      requireAck,
      retryTimer: null,
      ackTimer: null,
      awaitingAck: false,
    };

    this.pendingDeliveries.set(deliveryId, pending);
    this.scheduleRetry(deliveryId);
  }

  private trackPendingAck(targetHints: string[], msg: AIMMessage): void {
    const deliveryId = msg.deliveryId;
    if (!deliveryId) {
      return;
    }

    const existing = this.pendingDeliveries.get(deliveryId);
    const pending = existing || {
      targetHints,
      message: msg,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.resilienceConfig.offlineMessageTtlMs,
      attempts: 0,
      requireAck: true,
      retryTimer: null,
      ackTimer: null,
      awaitingAck: false,
    } satisfies PendingDelivery;

    pending.targetHints = targetHints;
    pending.message = msg;
    pending.requireAck = true;
    pending.awaitingAck = true;

    if (pending.retryTimer) {
      clearTimeout(pending.retryTimer);
      pending.retryTimer = null;
    }
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer);
    }

    pending.ackTimer = setTimeout(() => {
      pending.awaitingAck = false;
      pending.ackTimer = null;
      this.scheduleRetry(deliveryId);
    }, this.resilienceConfig.ackTimeoutMs);

    this.pendingDeliveries.set(deliveryId, pending);
  }

  private flushPendingDeliveriesFor(device: ConnectedDevice): void {
    for (const [deliveryId, pending] of this.pendingDeliveries) {
      if (pending.targetHints.some(target => this.matchesTarget(device, target))) {
        this.scheduleRetry(deliveryId, 0);
      }
    }
  }

  private scheduleRetry(deliveryId: string, overrideDelayMs?: number): void {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending) {
      return;
    }

    if (Date.now() > pending.expiresAt) {
      this.dropExpiredDelivery(deliveryId, pending);
      return;
    }

    if (pending.retryTimer) {
      clearTimeout(pending.retryTimer);
    }
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer);
      pending.ackTimer = null;
    }

    const delayMs = overrideDelayMs ?? this.getRetryDelay(pending.attempts);
    if (overrideDelayMs === undefined) {
      pending.attempts += 1;
    }

    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = null;
      this.processPendingDelivery(deliveryId);
    }, delayMs);
  }

  private processPendingDelivery(deliveryId: string): void {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending) {
      return;
    }

    if (Date.now() > pending.expiresAt) {
      this.dropExpiredDelivery(deliveryId, pending);
      return;
    }

    if (pending.awaitingAck) {
      return;
    }

    const conn = this.resolveDeviceConnection(pending.targetHints);
    if (!conn) {
      this.scheduleRetry(deliveryId);
      return;
    }

    this.deliverToConnection(pending.targetHints, conn, pending.message, pending.requireAck);
  }

  private dropExpiredDelivery(deliveryId: string, pending: PendingDelivery): void {
    const errorMessage: ErrorMessage = {
      type: 'error',
      message: `Queued ${pending.message.type} expired before target came back online`,
      requestId: pending.message.requestId,
      to: pending.message.from,
      details: {
        targetHints: pending.targetHints,
        deliveryId,
        ttlMs: this.resilienceConfig.offlineMessageTtlMs,
      },
    };

    console.warn(`[AIM] Dropping expired queued message ${deliveryId} for ${pending.targetHints.join(', ')}`);
    this.clearPendingDelivery(deliveryId);

    if (errorMessage.to) {
      this.sendToDevice(errorMessage.to, errorMessage);
    }
  }

  private resolveDeviceConnection(targetHints: string[]): DeviceConnection | null {
    for (const target of targetHints) {
      const byId = this.devices.get(target);
      if (byId && byId.ws.readyState === WebSocket.OPEN) {
        return byId;
      }

      for (const [, conn] of this.devices) {
        if (this.matchesTarget(conn.device, target) && conn.ws.readyState === WebSocket.OPEN) {
          return conn;
        }
      }
    }

    return null;
  }

  private matchesTarget(device: ConnectedDevice, target: string): boolean {
    return device.id === target || device.deviceType === target || device.deviceName === target;
  }

  private prepareOutgoingMessage(msg: AIMMessage, requireAck: boolean): AIMMessage {
    if (requireAck) {
      return {
        ...msg,
        deliveryId: msg.deliveryId || `delivery-${uuid()}`,
        requiresAck: true,
      };
    }

    if (!msg.deliveryId) {
      return msg;
    }

    return {
      ...msg,
      requiresAck: false,
    };
  }

  private requiresDeliveryAck(msg: AIMMessage): boolean {
    return CRITICAL_MESSAGE_TYPES.has(msg.type) || msg.requiresAck === true;
  }

  private getRetryDelay(attempts: number): number {
    return Math.min(this.resilienceConfig.retryBaseMs * 2 ** attempts, this.resilienceConfig.retryCapMs);
  }

  private clearPendingDelivery(deliveryId: string): void {
    const pending = this.pendingDeliveries.get(deliveryId);
    if (!pending) {
      return;
    }

    if (pending.retryTimer) {
      clearTimeout(pending.retryTimer);
    }
    if (pending.ackTimer) {
      clearTimeout(pending.ackTimer);
    }

    this.pendingDeliveries.delete(deliveryId);
  }

  private send(ws: WebSocket, msg: AIMMessage, onError?: (error: Error) => void): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          onError?.(err);
        }
      });
      return true;
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  get deviceCount(): number {
    return this.devices.size;
  }
}
