/**
 * AIM Protocol Types
 * Defines the message format for the AIM relay protocol.
 */

// Device types that can connect to AIM
export type DeviceType = 'mac' | 'phone' | 'watch' | 'web' | 'cli' | 'server' | 'custom';

// Message types flowing through AIM
export type MessageType =
  | 'register'       // Device registration
  | 'command'         // Voice/text command from any device
  | 'token'           // Streamed response token
  | 'response'        // Complete response
  | 'audio'           // Audio chunk (base64)
  | 'audioEnd'        // End of audio stream
  | 'status'          // Status broadcast (state changes)
  | 'error'           // Error message
  | 'ping'            // Keep-alive ping
  | 'pong'            // Keep-alive pong
  | 'route'           // Route a command to a specific device
  | 'broadcast'       // Broadcast to all devices
  | 'devices'         // List connected devices
  | 'ack'             // Acknowledgment
  | 'system_command'  // macOS command forwarded from server to Mac
  | 'system_command_result'  // Result of macOS command from Mac to server
  | 'play_audio';     // Audio playback request to Mac

// Base message structure
export interface AIMMessage {
  type: MessageType;
  requestId?: string;
  timestamp?: number;
  from?: string;       // device ID of sender
  to?: string;         // device ID of target (for routing)
  [key: string]: any;
}

// Registration message
export interface RegisterMessage extends AIMMessage {
  type: 'register';
  deviceType: DeviceType;
  deviceName?: string;
  capabilities?: string[];  // ['audio', 'display', 'microphone', 'tts', 'systemControl']
}

// Command message
export interface CommandMessage extends AIMMessage {
  type: 'command';
  text: string;
  noAudio?: boolean;
  respondTo?: string;  // device ID where response should go
}

// Token message (streaming)
export interface TokenMessage extends AIMMessage {
  type: 'token';
  text: string;
  done?: boolean;
}

// Audio message
export interface AudioMessage extends AIMMessage {
  type: 'audio';
  data: string;  // base64 encoded audio
  format?: string; // 'mp3', 'wav', etc.
}

// Status message
export interface StatusMessage extends AIMMessage {
  type: 'status';
  state: string;
  lastCommand?: string;
  respondingDevice?: string;
}

// Connected device info
export interface ConnectedDevice {
  id: string;
  deviceType: DeviceType;
  deviceName: string;
  capabilities: string[];
  connectedAt: number;
  lastSeen: number;
}

// AIM server config
export interface AIMConfig {
  port: number;
  authToken?: string;
  allowedOrigins?: string[];
  heartbeatInterval?: number;  // ms, default 30000
  maxMessageSize?: number;     // bytes, default 10MB
}
