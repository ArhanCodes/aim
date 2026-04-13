# AIM

Real time WebSocket relay server for AI assistants which routes commands, token streams and audio between devices.

```
  Watch ──┐
  Phone ──┤──→ AIM Server ──→ AI Backend
  Mac   ──┤     (relay)        (JARVIS)
  Web   ──┘
```

## Quick Start

```bash
npm install aim
```

### Start the server

```bash
npx aim
```

Or with config:

```bash
AIM_PORT=5225 AIM_AUTH_TOKEN=my-secret npx aim
```

### Connect a client

```typescript
import { AIMClient } from 'aim/client';

const client = new AIMClient({
  url: 'wss://relay.example.com',
  device: 'phone',
  name: 'iPhone',
  token: 'my-secret',
});

await client.connect();

// Send a command
client.sendCommand('What time is it?');

// Listen for streaming tokens
client.on('token', (msg) => {
  process.stdout.write(msg.text);
});

// Listen for audio
client.on('audio', (msg) => {
  playAudio(Buffer.from(msg.data, 'base64'));
});
```

## Protocol

AIM uses a JSON-based WebSocket protocol. Every message has a `type` field:

| Type | Direction | Description |
|------|-----------|-------------|
| `register` | Client → Server | Register device with capabilities |
| `command` | Client → Server | Send a voice/text command |
| `token` | Server → Client | Streamed response token |
| `audio` | Server → Client | Audio chunk (base64 MP3) |
| `audioEnd` | Server → Client | End of audio stream |
| `status` | Bidirectional | State updates (idle, processing, speaking) |
| `error` | Server → Client | Error message |
| `ping`/`pong` | Bidirectional | Keep-alive |
| `devices` | Client → Server | Request connected device list |
| `route` | Client → Server | Route message to specific device |

### Device Types

`mac` | `phone` | `watch` | `web` | `cli` | `custom`

### Authentication

Pass token via:
- URL param: `wss://relay.example.com?token=xxx`
- Header: `X-AIM-Token: xxx`
- Bearer: `Authorization: Bearer xxx`

### Message Routing

Messages can be routed to specific devices:

```json
{
  "type": "command",
  "text": "Hello",
  "respondTo": "device-id-or-type"
}
```

Use `respondTo: "mac"` to have the AI backend respond on the Mac, or `respondTo: "phone"` to respond on the phone.

### Secure Transport (TLS / `wss://`)

Use `wss://` for any networked deployment:

```typescript
const client = new AIMClient({
  url: 'wss://relay.example.com',
  device: 'phone',
  token: process.env.AIM_TOKEN,
});
```

`AIMClient` accepts both `ws://` and `wss://` URLs. For production, terminate TLS in front of AIM with a reverse proxy such as Caddy or Nginx and forward the upgraded WebSocket connection to the local AIM process (`ws://127.0.0.1:5225`). Example Caddyfile:

```caddy
relay.example.com {
  reverse_proxy 127.0.0.1:5225
}
```

Then connect clients with `wss://relay.example.com`. Keep `ws://localhost:5225` only for local development on a trusted machine.

## Architecture

AIM is a relay, it doesn't process commands itself. It routes messages between devices and an AI backend (JARVIS in my case). The backend registers as a `mac` or `cli` device and receives commands from other devices


The Mac runs JARVIS locally with all its features (voice, system control, menubar). It connects to AIM as a client, receives commands from remote devices, and sends responses back through AIM.

