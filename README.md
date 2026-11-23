# rest2ros

REST API and web dashboard bridging HTTP/WebSocket clients to ROS 1 and ROS 2 topics and services via `rosbridge_server` and `roslib`, built with TypeScript, Elysia, and Bun.

## Prerequisites

- [Bun](https://bun.com)
- ROS 1 (e.g. Noetic) or ROS 2 with `rosbridge_server` and `rosapi` running (e.g. `roslaunch rosbridge_server rosbridge_websocket.launch` on ROS 1, or `ros2 launch rosbridge_server rosbridge_websocket_launch.xml` on ROS 2)

## Quick Start

```bash
bun install
bun run start
```

Open `http://localhost:3000` for the dashboard.

### Scripts

- `bun run start` — run `src/index.ts`
- `bun run dev` — run with `--hot` reload
- `bun test` — run unit tests (`src/index.test.ts`)
- `bun run typecheck` — run `bun check`

### Environment Variables

- `PORT` — HTTP/WebSocket server port (default: `3000`)
- `ROSBRIDGE_URL` — rosbridge WebSocket URL (`ws://` or `wss://`, default: `ws://localhost:9090`)

## Dashboard (`GET /`)

- **Connection Config**: view status, update `ws://` / `wss://` rosbridge URL, and reconnect.
- **Topics & Monitor**: list/filter available ROS topics and subscribe to live message streams over `/ws`.
- **Publish Topic**: publish one-shot or repeating messages, monitor active repeating publishers, and stop individual topics or all at once.
- **Services**: list ROS services and invoke them with JSON requests.

## REST API

CORS (`Access-Control-Allow-Origin: *`) and `OPTIONS` preflight are enabled for all routes. Requests requiring rosbridge return `503` when disconnected.

### Status & Configuration

- `GET /api/status` — `{ connected, url, error }`
- `GET /api/config` — `{ url }`
- `POST /api/config` — body `{ "url": "ws://localhost:9090" }`, validates `ws://`/`wss://`, reconnects, returns status (`400` on invalid URL)
- `POST /api/reconnect` — reconnects to the configured rosbridge URL

### Topics

- `GET /api/topics` — returns `{ topics: [{ name, type }] }`
- `POST /api/topics/publish` — publishes to a ROS topic:

```json
{
  "topic": "/chatter",
  "type": "std_msgs/String",
  "payload": { "data": "hello" },
  "frequency": 10,
  "duration": 5
}
```

| `frequency` (Hz) | `duration` (s) | Behavior |
| --- | --- | --- |
| unset or `0` | unset, `0`, or `> 0` | Publish once (fire and forget) |
| `> 0` | unset or `0` | Publish repeatedly at `frequency` Hz until the next publish to that topic or stop |
| `> 0` | `> 0` | Publish repeatedly at `frequency` Hz for `duration` seconds |

Any new publish to a topic replaces an existing repeating publish on that same topic.

- `GET /api/topics/publishers` — lists active repeating publishers: `{ publishers: [{ topic, type, frequency, duration, startedAt, endsAt }] }`
- `POST /api/topics/publish/stop` — stops repeating publishers; pass `{ "topic": "/chatter" }` for one topic, or `{}` / no body to stop all. Returns `{ ok: true, stopped: string[] }`

### Services

- `GET /api/services` — returns `{ services: string[] }`
- `POST /api/services/call` — body `{ "service": string, "type": string, "request"?: {} }`, returns `{ ok: true, service, response }`

## WebSocket (`/ws`)

Used by the dashboard for real-time updates:

- Client sends:
  - `{ "action": "subscribe", "topic": "/chatter", "type": "std_msgs/String" }` (`type` optional)
  - `{ "action": "unsubscribe", "topic": "/chatter" }`
- Server pushes:
  - `{ "type": "status", "data": { connected, url, error } }`
  - `{ "type": "publishers", "data": [...] }`
  - `{ "type": "message", "topic": "/chatter", "data": ..., "ts": 1700000000000 }`

## Shutdown Behavior

On `SIGINT`, `SIGTERM`, `beforeExit`, or `app.stop()`, the server stops all repeating publishers, unadvertises cached topic publishers, and closes the rosbridge connection.

## ROS 1 & ROS 2 Compatibility

Because `rest2ros` communicates solely via `roslib` (`v2.1.0`) over the `rosbridge` v2 WebSocket protocol (`Ros`, `Topic`, `Service`, `getTopics`, `getServices`), it is **in principle compatible with both ROS 1 and ROS 2** when paired with a matching `rosbridge_suite` server (ROS 1 `rosbridge_suite` or ROS 2 `rosbridge_suite` `ros2` branch), with the following verified caveats:

- **Message & service type strings:** On ROS 2, `rosbridge_suite`'s `ros_loader` accepts both 3-part (`std_msgs/msg/String`) and 2-part (`std_msgs/String`) type strings, though ROS 2 `rosapi` returns 3-part types (`pkg/msg/Type`).
- **Payload schemas differ across ROS 1 / ROS 2:** Message fields must match the target ROS distribution (for example, `std_msgs/Header.stamp` uses `secs`/`nsecs` in ROS 1 vs `sec`/`nanosec` in ROS 2, and `Header` no longer has `seq` in ROS 2).
- **`rosapi` namespace requirement:** `roslib` queries `rosapi/topics` and `rosapi/services` as relative names; on ROS 2 this resolves to `/rosapi/topics` and `/rosapi/services` as long as `rosbridge_websocket` runs in the root `/` namespace (the default) alongside the `rosapi` node.
- **QoS & verification scope:** `rest2ros` uses `roslib`'s default `Topic` options without custom ROS 2 QoS profiles, which may not match strict non-default ROS 2 QoS policies. Compatibility here is verified by inspecting `roslib` and `rosbridge_suite` source; automated tests run against a mock transport rather than live ROS 1/ROS 2 instances.
