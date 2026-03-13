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
  DeviceType,
} from './types.js';

interface DeviceConnection {
  ws: WebSocket;
  device: ConnectedDevice;
}

export class AIMRelay {
  private devices: Map<string, DeviceConnection> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private commandHandler: ((msg: CommandMessage, from: ConnectedDevice) => void) | null = null;

  constructor(private heartbeatMs: number = 30000) {}

  /**
   * Register a handler for incoming commands.
   * This is how the AI backend (e.g., JARVIS) hooks in.
   */
  onCommand(handler: (msg: CommandMessage, from: ConnectedDevice) => void): void {
    this.commandHandler = handler;
  }

  /**
   * Register a new device connection.
   */
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

    // Close existing connection for same device ID (but not if it's the same socket re-registering)
    const existing = this.devices.get(id);
    if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(1000, 'Replaced by new connection');
    }

    this.devices.set(id, { ws, device });

    // Send registration ack with device ID
    this.send(ws, {
      type: 'ack',
      deviceId: id,
      message: `Registered as ${device.deviceName}`,
      connectedDevices: this.getDeviceList(),
    });

    // Notify all other devices
    this.broadcast({
      type: 'status',
      state: 'device_connected',
      device: { id, deviceType: device.deviceType, deviceName: device.deviceName },
      connectedDevices: this.getDeviceList(),
    }, id);

    console.log(`[AIM] Device registered: ${device.deviceName} (${device.deviceType}) [${id}]`);
    return id;
  }

  /**
   * Handle an incoming message from a device.
   */
  handleMessage(deviceId: string, raw: string): void {
    const conn = this.devices.get(deviceId);
    if (!conn) return;

    conn.device.lastSeen = Date.now();

    let msg: AIMMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(conn.ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    msg.from = deviceId;
    msg.timestamp = msg.timestamp || Date.now();

    switch (msg.type) {
      case 'ping':
        this.send(conn.ws, { type: 'pong' });
        break;

      case 'command':
        this.handleCommand(msg as CommandMessage, conn.device);
        break;

      case 'token':
      case 'response':
      case 'audio':
      case 'audioEnd':
      case 'error':
        // Route to target device or broadcast
        if (msg.to) {
          this.sendToDevice(msg.to, msg);
        } else {
          // Broadcast to all except sender
          this.broadcast(msg, deviceId);
        }
        break;

      case 'status':
        // Status updates go to everyone
        this.broadcast(msg);
        break;

      case 'route':
        // Explicit routing: send to a specific device
        if (msg.to) {
          this.sendToDevice(msg.to, msg);
        }
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
        // Forward unknown types — extensible protocol
        if (msg.to) {
          this.sendToDevice(msg.to, msg);
        } else {
          this.broadcast(msg, deviceId);
        }
    }
  }

  /**
   * Handle a command message.
   * Routes to the AI backend handler, or forwards to the target device.
   */
  private handleCommand(msg: CommandMessage, from: ConnectedDevice): void {
    console.log(`[AIM] Command from ${from.deviceName}: "${msg.text}"`);

    // If respondTo is set, the response should go to that device
    // Otherwise, response goes back to sender
    if (!msg.respondTo) {
      msg.respondTo = from.id;
    }

    // If there's a registered command handler (AI backend), use it
    if (this.commandHandler) {
      this.commandHandler(msg, from);
      return;
    }

    // Otherwise, route to the first 'mac' or 'cli' device (the AI backend)
    const backend = this.findBackend();
    if (backend) {
      this.send(backend.ws, msg);
    } else {
      // No backend connected — send error back to sender
      const senderConn = this.devices.get(from.id);
      if (senderConn) {
        this.send(senderConn.ws, {
          type: 'error',
          message: 'No AI backend connected',
          requestId: msg.requestId,
        });
      }
    }
  }

  /**
   * Find the AI backend device (server, mac, or cli type).
   * Priority: server (VPS JARVIS) > mac > cli
   */
  private findBackend(): DeviceConnection | null {
    let macConn: DeviceConnection | null = null;
    for (const [, conn] of this.devices) {
      if (conn.device.deviceType === 'server') {
        return conn; // Server (VPS) has highest priority
      }
      if (conn.device.deviceType === 'mac' || conn.device.deviceType === 'cli') {
        macConn = conn;
      }
    }
    return macConn;
  }

  /**
   * Send a response to the appropriate device(s) based on respondTo.
   * Called by the AI backend after processing a command.
   */
  sendResponse(msg: AIMMessage, respondTo?: string): void {
    if (respondTo) {
      this.sendToDevice(respondTo, msg);
    } else {
      this.broadcast(msg);
    }
  }

  /**
   * Send to a specific device by ID or device type.
   */
  sendToDevice(target: string, msg: AIMMessage): boolean {
    // Try by ID first
    let conn = this.devices.get(target);

    // Try by device type if not found by ID
    if (!conn) {
      for (const [, c] of this.devices) {
        if (c.device.deviceType === target || c.device.deviceName === target) {
          conn = c;
          break;
        }
      }
    }

    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      this.send(conn.ws, msg);
      return true;
    }
    return false;
  }

  /**
   * Broadcast a message to all connected devices (optionally excluding sender).
   */
  broadcast(msg: AIMMessage, excludeId?: string): void {
    const data = JSON.stringify(msg);
    for (const [id, conn] of this.devices) {
      if (id !== excludeId && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(data);
      }
    }
  }

  /**
   * Remove a disconnected device.
   */
  removeDevice(deviceId: string): void {
    const conn = this.devices.get(deviceId);
    if (conn) {
      console.log(`[AIM] Device disconnected: ${conn.device.deviceName} [${deviceId}]`);
      this.devices.delete(deviceId);

      // Notify remaining devices
      this.broadcast({
        type: 'status',
        state: 'device_disconnected',
        device: { id: deviceId, deviceType: conn.device.deviceType, deviceName: conn.device.deviceName },
        connectedDevices: this.getDeviceList(),
      });
    }
  }

  /**
   * Get list of connected devices (public info only).
   */
  getDeviceList(): Partial<ConnectedDevice>[] {
    return Array.from(this.devices.values()).map(c => ({
      id: c.device.id,
      deviceType: c.device.deviceType,
      deviceName: c.device.deviceName,
      capabilities: c.device.capabilities,
    }));
  }

  /**
   * Get a specific device by ID.
   */
  getDevice(id: string): ConnectedDevice | null {
    return this.devices.get(id)?.device || null;
  }

  /**
   * Start heartbeat checking.
   */
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

  /**
   * Stop heartbeat checking.
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send a message to a WebSocket.
   */
  private send(ws: WebSocket, msg: AIMMessage | Record<string, any>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Get connected device count.
   */
  get deviceCount(): number {
    return this.devices.size;
  }
}
