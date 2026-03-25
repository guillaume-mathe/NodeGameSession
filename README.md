# node-game-session

Session orchestrator for multiplayer games — lobbies, lifecycle, game server spawning, and stats persistence.

Part of the **node-game-\*** engine suite. Sits above [`node-game-server`](https://github.com/user/node-game-server) (authoritative match runner) and manages the full session lifecycle from lobby through match results.

## Install

```bash
npm install node-game-session
```

## Quick Start

```js
import {
  SessionManager,
  ChildProcessSpawner,
} from "node-game-session";

const spawner = new ChildProcessSpawner({
  modulePath: "./game-server.js",
  basePort: 9100,
});

const session = new SessionManager({
  minPlayers: 2,
  maxPlayers: 4,
  countdownMs: 3000,
  spawner,
  gameLogicModulePath: "./game-logic.js",
});

session.on("matchStarted", ({ matchId }) => {
  console.log(`Match ${matchId} started`);
});

session.on("matchEnded", ({ matchId, results }) => {
  console.log(`Match ${matchId} ended`, results);
});

await session.start(8080);
```

## Architecture

### Dual WebSocket connections

Players maintain two concurrent WebSocket connections:

1. **Session WS** (persistent) — connects to the `SessionManager` for lobby management, lifecycle events, chat, and reconnection routing.
2. **Game WS** (ephemeral) — connects to a spawned game server for gameplay ticks and ECS diffs. Created per match, torn down on match end.

### Lifecycle state machine

```
LOBBY → STARTING → SYNC_WAIT → COUNTDOWN → PLAYING → RESULTS → LOBBY
```

| State | Description |
|---|---|
| `LOBBY` | Players join, toggle ready state |
| `STARTING` | Session decided to start; game server is spawning |
| `SYNC_WAIT` | Game server ready; waiting for all clients to connect |
| `COUNTDOWN` | All players connected; countdown in progress |
| `PLAYING` | Match is live |
| `RESULTS` | Match ended; results displayed, stats persisted |

Every state can also transition back to `LOBBY` (abort / error recovery).

### Game server spawning

The library uses a pluggable **`GameServerSpawner`** interface. Concrete implementations handle deployment topology:

- **`ChildProcessSpawner`** — v1, single machine, Node.js `child_process` with IPC
- Future: `ContainerSpawner`, `RemoteSpawner` for horizontal scaling

### Stats persistence

A pluggable **`StatsStore`** interface records match results (wins, losses, draws, playtime). Subclass it to back with any database or file store.

## Protocol

### Client protocol (session ↔ player)

Messages over the persistent session WebSocket.

**Client → Session:**

| Constant | Value | Description |
|---|---|---|
| `CLIENT_JOIN` | `"client:join"` | Player requests to join the lobby |
| `CLIENT_READY` | `"client:ready"` | Player marks themselves as ready |
| `CLIENT_UNREADY` | `"client:unready"` | Player marks themselves as not ready |
| `CLIENT_LEAVE` | `"client:leave"` | Player leaves the session |

**Session → Client:**

| Constant | Value | Description |
|---|---|---|
| `SESSION_LOBBY_STATE` | `"session:lobby_state"` | Full lobby state snapshot (sent on join) |
| `SESSION_PLAYER_JOINED` | `"session:player_joined"` | A player joined the lobby |
| `SESSION_PLAYER_LEFT` | `"session:player_left"` | A player left the lobby |
| `SESSION_LIFECYCLE_CHANGE` | `"session:lifecycle_change"` | Lifecycle state changed |
| `SESSION_CONNECT_TO_GAME` | `"session:connect_to_game"` | Tells the client to connect to the game server |
| `SESSION_MATCH_RESULTS` | `"session:match_results"` | Match results after game ends |
| `SESSION_ERROR` | `"session:error"` | Error message |

### Control channel (session ↔ game server)

Internal IPC between `SessionManager` and a spawned game server. For v1 this uses Node.js `child_process` IPC; designed to swap to HTTP/message-queue for distributed deployment.

| Constant | Value | Direction | Description |
|---|---|---|---|
| `CTRL_SPAWN` | `"ctrl:spawn"` | Session → Server | Spawn a new match |
| `CTRL_READY` | `"ctrl:ready"` | Server → Session | Server ready for player connections |
| `CTRL_PLAYER_CONNECTED` | `"ctrl:player_connected"` | Server → Session | A player connected to the game server |
| `CTRL_MATCH_RESULT` | `"ctrl:match_result"` | Server → Session | Match finished with results |
| `CTRL_SHUTDOWN` | `"ctrl:shutdown"` | Session → Server | Graceful shutdown |
| `CTRL_ABORT` | `"ctrl:abort"` | Either | Abort the current match immediately |

## API

Full API reference: [docs/api.md](docs/api.md)

## Development

```bash
npm run build          # esbuild ESM bundle + tsc declarations → dist/
npm run build:bundle   # esbuild only
npm run build:types    # tsc declarations only
npm test               # vitest run
```

## License

ISC
