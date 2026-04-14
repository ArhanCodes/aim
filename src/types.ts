/**
 * AIM Protocol Types
 * Defines the message format for the AIM relay protocol.
 */

export type DeviceType = 'mac' | 'phone' | 'watch' | 'web' | 'cli' | 'server' | 'custom';

export type MessageType =
  | 'register'
  | 'command'
  | 'token'
  | 'response'
  | 'audio'
  | 'audioEnd'
  | 'status'
  | 'error'
  | 'ping'
  | 'pong'
  | 'route'
  | 'broadcast'
  | 'devices'
  | 'ack'
  | 'system_command'
  | 'system_command_result'
  | 'play_audio';

export interface ConnectedDevice {
  id: string;
  deviceType: DeviceType;
  deviceName: string;
  capabilities: string[];
  connectedAt: number;
  lastSeen: number;
}

interface AIMMessageBase<T extends MessageType> {
  type: T;
  requestId?: string;
  timestamp?: number;
  from?: string;
  to?: string;
  deliveryId?: string;
  requiresAck?: boolean;
}

export interface RegisterMessage extends AIMMessageBase<'register'> {
  deviceType: DeviceType;
  deviceName?: string;
  capabilities?: string[];
}

export interface CommandMessage extends AIMMessageBase<'command'> {
  text: string;
  noAudio?: boolean;
  respondTo?: string;
}

export interface TokenMessage extends AIMMessageBase<'token'> {
  text: string;
  done?: boolean;
}

export interface ResponseMessage extends AIMMessageBase<'response'> {
  text: string;
  done?: boolean;
}

export interface AudioMessage extends AIMMessageBase<'audio'> {
  data: string;
  format?: string;
}

export interface AudioEndMessage extends AIMMessageBase<'audioEnd'> {}

export interface StatusMessage extends AIMMessageBase<'status'> {
  state: string;
  lastCommand?: string;
  respondingDevice?: string;
  device?: Pick<ConnectedDevice, 'id' | 'deviceType' | 'deviceName'>;
  connectedDevices?: Array<Pick<ConnectedDevice, 'id' | 'deviceType' | 'deviceName' | 'capabilities'>>;
  details?: Record<string, unknown>;
}

export interface ErrorMessage extends AIMMessageBase<'error'> {
  message: string;
  code?: string;
  raw?: string;
  details?: Record<string, unknown>;
}

export interface PingMessage extends AIMMessageBase<'ping'> {}

export interface PongMessage extends AIMMessageBase<'pong'> {}

export interface RouteMessage extends AIMMessageBase<'route'> {
  to: string;
}

export interface BroadcastMessage extends AIMMessageBase<'broadcast'> {}

export interface DevicesMessage extends AIMMessageBase<'devices'> {
  devices?: Array<Pick<ConnectedDevice, 'id' | 'deviceType' | 'deviceName' | 'capabilities'>>;
}

export interface AckMessage extends AIMMessageBase<'ack'> {
  ackType?: 'register' | 'delivery';
  deliveryId?: string;
  delivered?: boolean;
  deviceId?: string;
  message?: string;
  connectedDevices?: Array<Pick<ConnectedDevice, 'id' | 'deviceType' | 'deviceName' | 'capabilities'>>;
}

export interface SystemCommandMessage extends AIMMessageBase<'system_command'> {
  command: string;
  args?: string[];
}

export interface SystemCommandResultMessage extends AIMMessageBase<'system_command_result'> {
  success: boolean;
  output?: string;
  error?: string;
}

export interface PlayAudioMessage extends AIMMessageBase<'play_audio'> {
  data?: string;
  format?: string;
  audioUrl?: string;
  autoplay?: boolean;
}

export type AIMMessage =
  | RegisterMessage
  | CommandMessage
  | TokenMessage
  | ResponseMessage
  | AudioMessage
  | AudioEndMessage
  | StatusMessage
  | ErrorMessage
  | PingMessage
  | PongMessage
  | RouteMessage
  | BroadcastMessage
  | DevicesMessage
  | AckMessage
  | SystemCommandMessage
  | SystemCommandResultMessage
  | PlayAudioMessage;

export interface AIMConfig {
  port: number;
  authToken?: string;
  allowedOrigins?: string[];
  heartbeatInterval?: number;
  maxMessageSize?: number;
}
