# API Reference

## Exports

```js
import {
  // Core
  SessionManager,

  // Lifecycle
  LifecycleStateMachine,
  LifecycleState,

  // Lobby
  Lobby,
  StartCondition,

  // Spawner
  GameServerSpawner,
  ChildProcessSpawner,

  // Stats
  StatsStore,

  // Protocol — client
  CLIENT_JOIN,
  CLIENT_READY,
  CLIENT_UNREADY,
  CLIENT_LEAVE,
  SESSION_LOBBY_STATE,
  SESSION_PLAYER_JOINED,
  SESSION_PLAYER_LEFT,
  SESSION_LIFECYCLE_CHANGE,
  SESSION_CONNECT_TO_GAME,
  SESSION_MATCH_RESULTS,
  SESSION_ERROR,

  // Protocol — control channel
  CTRL_SPAWN,
  CTRL_READY,
  CTRL_PLAYER_CONNECTED,
  CTRL_MATCH_RESULT,
  CTRL_SHUTDOWN,
  CTRL_ABORT,
} from "node-game-session";
```

---

## SessionManager

Main session orchestrator. Manages the lobby, lifecycle state machine, game server spawning, and player WebSocket connections.

Extends `EventEmitter`.

### Constructor

```js
const session = new SessionManager(config);
```

| Name | Type | Default | Description |
|---|---|---|---|
| `minPlayers` | `number` | — | Minimum players required to start a match |
| `maxPlayers` | `number` | — | Maximum players allowed in the lobby |
| `countdownMs` | `number` | `3000` | Countdown duration before match begins (ms) |
| `reconnectGraceMs` | `number` | `10000` | Grace period for player reconnection (ms) |
| `spawner` | `GameServerSpawner` | — | Game server spawner implementation |
| `gameLogicModulePath` | `string` | — | Path to the game server entry module |
| `tickRateHz` | `number` | `20` | Game server tick rate |
| `statsStore` | `StatsStore` | `undefined` | Optional stats persistence backend |
| `gameConfig` | `Record<string, unknown>` | `undefined` | Optional game-specific configuration passed to the game server |

### Getters

#### `lifecycle`

**Returns:** `LifecycleStateMachine` — the internal lifecycle state machine (read-only access).

#### `lobby`

**Returns:** `Lobby` — the internal lobby (read-only access).

### Methods

#### `start(port)`

Start the session manager WebSocket server.

| Name | Type | Description |
|---|---|---|
| `port` | `number` | Port to listen on |

**Returns:** `Promise<void>`

#### `shutdown()`

Gracefully shut down the session manager. Closes the WebSocket server, shuts down any running game server, and cleans up resources.

**Returns:** `Promise<void>`

#### `getLobbyState()`

Get a snapshot of the current lobby state.

**Returns:** `{ players: LobbyPlayer[], lifecycleState: string }`

### Events

| Event | Payload | Description |
|---|---|---|
| `"matchStarted"` | `{ matchId: string }` | A match has been spawned and started |
| `"matchEnded"` | `{ matchId: string, results: PlayerMatchResult[] }` | A match has ended with results |
| `"error"` | `Error` | An error occurred |

---

## LifecycleStateMachine

Finite state machine for the session lifecycle. Enforces a strict transition table and emits events on state changes.

Extends `EventEmitter`.

### LifecycleState

Enum of all lifecycle states:

| Key | Value | Description |
|---|---|---|
| `LOBBY` | `"LOBBY"` | Players join and toggle ready state |
| `STARTING` | `"STARTING"` | Game server is being spawned |
| `SYNC_WAIT` | `"SYNC_WAIT"` | Waiting for all clients to connect to game server |
| `COUNTDOWN` | `"COUNTDOWN"` | Pre-match countdown in progress |
| `PLAYING` | `"PLAYING"` | Match is live |
| `RESULTS` | `"RESULTS"` | Match ended, displaying results |

### Transition table

| From | Allowed targets |
|---|---|
| `LOBBY` | `STARTING` |
| `STARTING` | `SYNC_WAIT`, `LOBBY` |
| `SYNC_WAIT` | `COUNTDOWN`, `LOBBY` |
| `COUNTDOWN` | `PLAYING`, `LOBBY` |
| `PLAYING` | `RESULTS`, `LOBBY` |
| `RESULTS` | `LOBBY` |

### Getters

#### `state`

**Returns:** `string` — the current lifecycle state.

### Methods

#### `canTransition(target)`

Check whether a transition from the current state to `target` is valid.

| Name | Type | Description |
|---|---|---|
| `target` | `string` | Target state to check |

**Returns:** `boolean`

#### `transition(target)`

Transition to `target` if valid. Throws if the transition is not allowed.

| Name | Type | Description |
|---|---|---|
| `target` | `string` | Target state to transition to |

**Returns:** `void`

**Throws:** `Error` — if the transition is invalid.

#### `reset()`

Reset the state machine back to `LOBBY`. Emits a `"transition"` event if not already in `LOBBY`.

**Returns:** `void`

### Events

| Event | Payload | Description |
|---|---|---|
| `"transition"` | `{ from: string, to: string }` | Fired on every valid state transition |

---

## Lobby

Manages the set of connected players and their ready state. The first player to join becomes the lobby leader; if the leader leaves, leadership passes to the next player.

Extends `EventEmitter`.

### StartCondition

Enum for lobby start conditions:

| Key | Value | Description |
|---|---|---|
| `ALL_READY` | `"ALL_READY"` | Match starts when all players are ready and minimum is met |
| `LEADER_START` | `"LEADER_START"` | The lobby leader starts manually (all players must still be ready) |

### Constructor

```js
const lobby = new Lobby(opts);
```

| Name | Type | Default | Description |
|---|---|---|---|
| `minPlayers` | `number` | — | Minimum players required to start |
| `maxPlayers` | `number` | — | Maximum players allowed |
| `startCondition` | `string` | `StartCondition.ALL_READY` | Start condition mode |

### Methods

#### `addPlayer(playerId, displayName)`

Add a player to the lobby. The first player added becomes the leader.

| Name | Type | Description |
|---|---|---|
| `playerId` | `string` | Unique player identifier |
| `displayName` | `string` | Player display name |

**Returns:** `LobbyPlayer`

**Throws:** `Error` — if the player is already in the lobby or the lobby is full.

#### `removePlayer(playerId)`

Remove a player from the lobby. If the removed player was the leader, leadership is reassigned.

| Name | Type | Description |
|---|---|---|
| `playerId` | `string` | Player to remove |

**Returns:** `void`

#### `setReady(playerId)`

Mark a player as ready.

| Name | Type | Description |
|---|---|---|
| `playerId` | `string` | Player to mark ready |

**Returns:** `void`

**Throws:** `Error` — if the player is not in the lobby.

#### `setUnready(playerId)`

Mark a player as not ready.

| Name | Type | Description |
|---|---|---|
| `playerId` | `string` | Player to mark unready |

**Returns:** `void`

**Throws:** `Error` — if the player is not in the lobby.

#### `getPlayers()`

Get all players as an array.

**Returns:** `LobbyPlayer[]`

#### `isStartConditionMet()`

Whether the configured start condition is satisfied (enough players and all are ready).

**Returns:** `boolean`

#### `resetReady()`

Reset all players' ready flags to `false`.

**Returns:** `void`

#### `buildPlayerManifest()`

Build a player manifest for the game server spawn message.

**Returns:** `PlayerManifestEntry[]`

### Types

#### `LobbyPlayer`

```ts
{
  playerId: string;
  displayName: string;
  ready: boolean;
  isLeader: boolean;
}
```

### Events

| Event | Payload | Description |
|---|---|---|
| `"playerAdded"` | `{ player: LobbyPlayer }` | A player was added to the lobby |
| `"playerRemoved"` | `{ playerId: string }` | A player was removed from the lobby |
| `"readyChanged"` | `{ playerId: string, ready: boolean }` | A player's ready state changed |

---

## GameServerSpawner

Abstract base class for game server spawners. Subclass this to implement a specific deployment topology (child process, container, remote machine, etc.).

### Types

#### `GameServerInstance`

```ts
{
  matchId: string;
  port: number;
  host: string;
  handle?: unknown;  // implementation-specific process/container handle
}
```

#### `SpawnConfig`

```ts
{
  matchId: string;
  players: PlayerManifestEntry[];
  tickRateHz: number;
  gameConfig?: Record<string, unknown>;
}
```

### Methods

#### `spawn(config, onMessage)`

Spawn a game server instance.

| Name | Type | Description |
|---|---|---|
| `config` | `SpawnConfig` | Match configuration |
| `onMessage` | `(message: unknown) => void` | Callback for control-channel messages from the server |

**Returns:** `Promise<GameServerInstance>`

#### `send(instance, message)`

Send a control-channel message to a running game server.

| Name | Type | Description |
|---|---|---|
| `instance` | `GameServerInstance` | Target server instance |
| `message` | `unknown` | Message to send |

**Returns:** `void`

#### `shutdown(instance)`

Shut down a running game server instance.

| Name | Type | Description |
|---|---|---|
| `instance` | `GameServerInstance` | Server instance to shut down |

**Returns:** `Promise<void>`

---

## ChildProcessSpawner

Spawns game server instances as Node.js child processes on the local machine. Communication uses Node.js IPC (`child_process.fork` with `send` / `on("message")`).

Extends `GameServerSpawner`.

### Constructor

```js
const spawner = new ChildProcessSpawner(opts);
```

| Name | Type | Default | Description |
|---|---|---|---|
| `modulePath` | `string` | — | Path to the game server entry module |
| `basePort` | `number` | `9100` | Starting port for spawned servers |
| `host` | `string` | `"127.0.0.1"` | Host address for spawned servers |

### Methods

Inherits `spawn(config, onMessage)`, `send(instance, message)`, and `shutdown(instance)` from `GameServerSpawner`.

---

## StatsStore

Abstract base class for stats persistence. Subclass this to back with a database, file, or in-memory store.

### Types

#### `PlayerStats`

```ts
{
  playerId: string;
  wins: number;
  losses: number;
  draws: number;
  totalPlaytimeMs: number;
  matchesPlayed: number;
}
```

### Methods

#### `getPlayer(playerId)`

Get stats for a player.

| Name | Type | Description |
|---|---|---|
| `playerId` | `string` | Player to look up |

**Returns:** `Promise<PlayerStats | null>`

#### `createPlayer(playerId)`

Create a new player stats record with zeroed counters.

| Name | Type | Description |
|---|---|---|
| `playerId` | `string` | Player to create |

**Returns:** `Promise<PlayerStats>`

#### `updatePlayerStats(playerId, update)`

Update a player's stats (merges partial updates).

| Name | Type | Description |
|---|---|---|
| `playerId` | `string` | Player to update |
| `update` | `Partial<PlayerStats>` | Fields to merge |

**Returns:** `Promise<PlayerStats>`

#### `getOrCreatePlayer(playerId)`

Get stats for a player, creating a new record if none exists. This is a concrete method — it does not need to be overridden.

| Name | Type | Description |
|---|---|---|
| `playerId` | `string` | Player to look up or create |

**Returns:** `Promise<PlayerStats>`

---

## Protocol Constants

### Client protocol (session ↔ player)

**Client → Session Manager:**

| Constant | Value | Description |
|---|---|---|
| `CLIENT_JOIN` | `"client:join"` | Player requests to join the lobby |
| `CLIENT_READY` | `"client:ready"` | Player marks themselves as ready |
| `CLIENT_UNREADY` | `"client:unready"` | Player marks themselves as not ready |
| `CLIENT_LEAVE` | `"client:leave"` | Player leaves the session |

**Session Manager → Client:**

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

| Constant | Value | Direction | Description |
|---|---|---|---|
| `CTRL_SPAWN` | `"ctrl:spawn"` | Session → Server | Spawn a new match |
| `CTRL_READY` | `"ctrl:ready"` | Server → Session | Server ready for player connections |
| `CTRL_PLAYER_CONNECTED` | `"ctrl:player_connected"` | Server → Session | A player connected to the game server |
| `CTRL_MATCH_RESULT` | `"ctrl:match_result"` | Server → Session | Match finished with results |
| `CTRL_SHUTDOWN` | `"ctrl:shutdown"` | Session → Server | Graceful shutdown |
| `CTRL_ABORT` | `"ctrl:abort"` | Either | Abort the current match immediately |

---

## Protocol Types

### Client message types

#### `JoinMessage`

```ts
{ kind: "client:join"; playerId: string; displayName: string }
```

#### `LobbyStateMessage`

```ts
{ kind: "session:lobby_state"; players: LobbyPlayer[]; lifecycleState: string }
```

#### `PlayerJoinedMessage`

```ts
{ kind: "session:player_joined"; player: LobbyPlayer }
```

#### `PlayerLeftMessage`

```ts
{ kind: "session:player_left"; playerId: string }
```

#### `LifecycleChangeMessage`

```ts
{ kind: "session:lifecycle_change"; state: string }
```

#### `ConnectToGameMessage`

```ts
{ kind: "session:connect_to_game"; matchId: string; host: string; port: number; token: string }
```

#### `MatchResultsMessage`

```ts
{ kind: "session:match_results"; results: PlayerMatchResult[]; durationMs: number }
```

#### `ErrorMessage`

```ts
{ kind: "session:error"; message: string }
```

### Control channel message types

#### `SpawnMessage`

```ts
{ kind: "ctrl:spawn"; matchId: string; players: PlayerManifestEntry[]; tickRateHz: number; gameConfig?: Record<string, unknown> }
```

#### `ReadyMessage`

```ts
{ kind: "ctrl:ready"; matchId: string; port: number; host: string }
```

#### `PlayerConnectedMessage`

```ts
{ kind: "ctrl:player_connected"; matchId: string; playerId: string }
```

#### `PlayerMatchResult`

```ts
{ playerId: string; outcome: "win" | "loss" | "draw"; score: number }
```

#### `MatchResultMessage`

```ts
{ kind: "ctrl:match_result"; matchId: string; results: PlayerMatchResult[]; durationMs: number }
```

#### `ShutdownMessage`

```ts
{ kind: "ctrl:shutdown" }
```

#### `AbortMessage`

```ts
{ kind: "ctrl:abort"; matchId: string; reason?: string }
```

#### `PlayerManifestEntry`

```ts
{ playerId: string; displayName: string }
```
