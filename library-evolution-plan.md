# Engine Library Evolution Plan

**Version:** 0.1-draft
**Status:** In design
**Last updated:** 2026-03-25

Companion document to the [Bomberman Game Design Document](./game-design-document.md). This document tracks improvements, new libraries, and architectural changes needed in the engine library suite, driven by the Bomberman implementation but designed for reuse across future games.

---

## 1. Current library inventory

| Package | Version | Role | Maturity |
|---------|---------|------|----------|
| `node-game-server` | 0.x | Server: tick loop, state management, rollback, WebSocket, snapshot/delta | Working, needs ECS-aware diffing |
| `node-game-client` | 0.x | Client: sync handshake, state reconciliation, reconnection | Working, needs ECS-aware reconciliation |
| `node-game-ecs` | 0.x | ECS: World, defineComponent, query, systems | Working, needs diff/snapshot support |
| `node-game-renderer` | 0.x | Canvas 2D: scene graph, sprite sheets, tile maps, camera | Working, adequate for Bomberman |
| `node-game-input-manager` | 0.x | Input: intent mapping, keyboard/gamepad, edge detection | Working, adequate for Bomberman |

---

## 2. ECS-aware wire protocol

### 2.1 Problem

The current `node-game-server` wire protocol sends state as opaque JSON/Cap'n Proto blobs. The `GameLogic.tick()` function returns a plain state object, and the server's `NetworkAdapter` diffs it at the JSON level (property-by-property). This works, but:

- **No entity identity:** JSON diffing doesn't know that `players[2]` is the same entity as last tick's `players[2]` — it diffs by array index, which breaks when entities are added/removed mid-array.
- **No component-level granularity:** A single field change on one component causes the entire entity's state to be re-sent.
- **Game layer does double work:** The game must convert ECS World → plain state → wire, and the server diffs the plain state. The ECS World already knows exactly which components changed — that information is discarded during `toState()` serialization.

### 2.2 Proposed solution: ECS diff integration

Let `node-game-ecs` track component mutations natively, and let `node-game-server` consume those diffs directly.

**ECS World changes (`node-game-ecs`):**

- `World` gains a **dirty tracking** system. Each `world.set()` / `world.add()` / `world.remove()` / `world.create()` / `world.destroy()` marks the affected entity+component as dirty.
- `world.flushDiffs()` returns a structured diff object (entities added/updated/removed, with per-component granularity) and clears the dirty set.
- `world.snapshot()` returns a full serializable state of all entities and components (for initial snapshots and rollback checkpoints).
- `world.applyDiff(diff)` applies a diff to the world (for client-side reconciliation).
- `world.applySnapshot(snapshot)` replaces the entire world state (for rollback restore).

**Diff format (language-level, pre-serialization):**

```js
{
  frame: 42,
  entities: [
    { id: 7, op: "add", components: { Position: { x: 100, y: 200 }, Player: { id: "alice", alive: true } } },
    { id: 3, op: "update", components: { Position: { x: 105, y: 200 } } },  // only changed components
    { id: 12, op: "remove" },
  ]
}
```

**Server changes (`node-game-server`):**

- New `GameLogic` variant: `GameLogicECS` interface that exposes the ECS `World` directly instead of returning plain state from `tick()`.
- The server's `NetworkAdapter` consumes `world.flushDiffs()` output instead of doing its own JSON diffing.
- Snapshot/delta hybrid delivery unchanged — full snapshots use `world.snapshot()`, deltas use `world.flushDiffs()`.
- The existing `GameLogic` (plain state) interface remains supported for simpler games.

**Client changes (`node-game-client`):**

- Client receives diffs and applies them via `world.applyDiff(diff)` instead of replacing the entire state object.
- Rollback: client stores periodic snapshots via `world.snapshot()`, restores with `world.applySnapshot()`, then re-applies buffered inputs.

**Serialization (codec layer):**

- The diff format is codec-agnostic at the ECS level. The codec (JSON or Cap'n Proto) serializes/deserializes the diff structure.
- For Cap'n Proto: this maps directly to the `engine.capnp` schema from the game design doc (§9.1) — `WorldDiff` → `EntityDiff` → `ComponentDiff` with `AnyPointer` payloads.
- For JSON: straightforward object serialization.
- The game layer registers a component serializer per component type, which the codec uses for the payload portion. This keeps the engine generic while allowing typed component serialization.

### 2.3 Component serializer registry

The bridge between game-specific components and the engine's generic diff format:

```js
import { World, defineComponent, createComponentRegistry } from "node-game-ecs";

const Position = defineComponent("Position", { x: 0, y: 0 });
const Velocity = defineComponent("Velocity", { vx: 0, vy: 0 });

const registry = createComponentRegistry();
registry.register(Position, {
  id: 0,
  serialize: (data) => ({ x: data.x, y: data.y }),
  deserialize: (raw) => ({ x: raw.x, y: raw.y }),
});
registry.register(Velocity, {
  id: 1,
  serialize: (data) => ({ vx: data.vx, vy: data.vy }),
  deserialize: (raw) => ({ vx: raw.vx, vy: raw.vy }),
});
```

The registry is passed to both the server codec and the client reconciliation layer. For Cap'n Proto, the serialize/deserialize functions produce/consume the typed struct payloads from `bomberman.capnp`.

### 2.4 Diff policy hooks

Not all components should be diffed every tick. The registry supports a `diffPolicy` per component:

```js
registry.register(PlayerStatus, {
  id: 8,
  diffPolicy: "transition",  // only diff on state change, not every tick
  serialize: (data) => ({ ... }),
  deserialize: (raw) => ({ ... }),
});
```

Policies:
- `"always"` (default) — include in diff whenever dirty.
- `"transition"` — include only when the value changes meaningfully (not just a timer decrement). The component provides an `equals(prev, curr)` function; the dirty flag is only set when equals returns false.
- `"snapshot-only"` — never included in per-tick diffs, only in full snapshots. Useful for large static data (e.g., map tiles).
- `"client-only"` — never serialized. The component exists only in the local ECS world.

---

## 3. New library: `node-game-session`

### 3.1 Problem

Lobby management, player identity, game lifecycle (lobby → countdown → playing → results → lobby), and session persistence are game-level concerns that every multiplayer game needs. Currently the Bomberman design bakes all of this into `onGameEvent()` inside the game logic, mixing session management with gameplay.

Additionally, coupling the lobby and the game server into a single process makes horizontal scaling difficult — you can't distribute game instances across machines without also distributing the lobby state.

### 3.2 Proposed scope

A new `node-game-session` library that acts as the **master orchestrator**. It owns player connections, lobbies, and lifecycle, and **spawns a `node-game-server` instance per match**. The game server is an ephemeral worker that runs one match and reports results back.

**Session manager responsibilities:**

- **Player connections:** Persistent WebSocket between players and the session manager. Handles identity (nickname/token), session suspend/resume, reconnection routing.
- **Lobby:** Player list, ready state, lobby leader, configurable start conditions (all ready, leader starts, min players). Player metadata (color, team, stats preview).
- **Game lifecycle state machine:** `LOBBY → STARTING → SYNC_WAIT → COUNTDOWN → PLAYING → RESULTS → LOBBY`. The session manager drives transitions and coordinates between players and the game server.
- **Game server spawning:** When a match starts, the session manager spawns a `node-game-server` instance (child process, container, or remote node) with the match configuration (player manifest, map seed, tick rate, game logic module). It hands the game server URL back to clients, who open a second WebSocket for gameplay.
- **Stats persistence:** Pluggable stats store interface. When the game server reports match results, the session manager records them.

**Game server responsibilities (unchanged `node-game-server`):**

- Runs one match. Receives a player manifest and match config at startup.
- Handles the real-time tick loop, ECS world, rollback, and state diffing.
- Does not know about lobbies, stats, or other matches.
- On match end, reports results (rankings, match duration) to the session manager and shuts down.

### 3.3 Connection architecture

Players maintain two connections:

```
┌────────┐       persistent WS        ┌─────────────────┐
│ Client │◄───────────────────────────►│  Session Manager │
│        │   (lobby, lifecycle, stats) │  (node-game-     │
│        │                             │   session)        │
│        │                             └────────┬─────────┘
│        │                                      │ spawns
│        │       per-match WS          ┌────────▼─────────┐
│        │◄───────────────────────────►│  Game Server      │
│        │   (gameplay, ticks, diffs)  │  (node-game-      │
└────────┘                             │   server)         │
                                       └──────────────────┘
```

**Flow:**

1. Client connects to session manager via WebSocket. Sends nickname, receives lobby state.
2. Lobby fills, players ready up. Session manager decides to start a match.
3. Session manager spawns a game server with the match config (player list, map seed, game logic).
4. Session manager sends the game server's connection URL to all clients.
5. Clients open a second WebSocket to the game server. The game server runs the sync handshake, countdown, and gameplay as defined by `node-game-server`.
6. During the match, the session manager's connection remains open for out-of-band communication (spectator join, chat, reconnection coordination).
7. On match end, the game server sends results to the session manager (via the control channel) and closes all client connections. Clients fall back to the session manager connection.
8. Session manager updates stats, returns players to the lobby.

### 3.4 Session ↔ game server control channel

The session manager needs an internal protocol to communicate with game server instances. This is not player-facing.

| Direction | Message | Content |
|-----------|---------|---------|
| Session → Game | `spawn` | Match config: player manifest, map seed, tick rate, game logic module path |
| Game → Session | `ready` | Game server is listening, reports its player-facing URL/port |
| Game → Session | `player_connected` | Player completed sync handshake on game server |
| Game → Session | `match_result` | Rankings, match duration, per-player stats delta |
| Game → Session | `shutdown` | Game server is terminating |
| Session → Game | `abort` | Force-terminate the match (e.g., all players disconnected) |

For single-instance deployment (Bomberman v1), the game server is a child process and the control channel is IPC (Node.js `child_process` messages). For distributed deployment, this becomes HTTP/REST or a lightweight message queue.

### 3.5 Lifecycle state machine

```
LOBBY ──[all ready]──► STARTING ──[game server ready]──► SYNC_WAIT ──[all clients on game server]──► COUNTDOWN ──[timer 0]──► PLAYING
  ▲                                                                                                                               │
  │                                                                                                                               │
  └──────────────────────────────────────────────── RESULTS ◄──[match_result from game server]────────────────────────────────────┘
```

The `STARTING` state is new compared to the earlier design — it covers the time between the lobby decision to start and the game server being ready to accept connections. During this state, the session manager shows a "Starting game..." message to clients.

### 3.6 Reconnection flow

When a player's connection to the game server drops mid-match:

1. The game server fires a `SUSPEND` event (per existing `node-game-server` behavior). The player entity stays in the ECS world.
2. The player's session manager connection may or may not also drop. If it's still alive, the session manager knows the player is suspended and can route them back.
3. When the player reconnects to the session manager, the session manager tells the client to reconnect to the game server URL.
4. The game server handles the resume via its existing sync handshake (`resumed: true` in `sync_result`).
5. If the reconnect grace period expires, the game server fires `DISCONNECT` and reports this to the session manager.

### 3.7 Scaling model

| Deployment | Session manager | Game servers | Control channel |
|------------|-----------------|--------------|-----------------|
| Single instance (Bomberman v1) | One process | Child processes | Node.js IPC |
| Vertical scaling | One process | Worker threads or child processes | IPC |
| Horizontal scaling | Cluster behind load balancer (sticky sessions for WS) | Separate machines / containers | HTTP / message queue |
| Cloud / serverless | Managed WebSocket service | On-demand containers (e.g., Fly.io machines, ECS tasks) | HTTP API |

The library provides a `GameServerSpawner` interface. The game implements a concrete spawner for its deployment model:

```js
import { SessionManager } from "node-game-session";

const session = new SessionManager({
  minPlayers: 2,
  maxPlayers: 6,
  countdownMs: 3000,
  reconnectGraceMs: 30000,
  statsStore: sqliteStore,
  spawner: new ChildProcessSpawner({      // or ContainerSpawner, RemoteSpawner, etc.
    modulePath: "./bomberman-logic.js",
    basePort: 9000,
  }),
});

session.on("lobby:playerJoined", (player) => { /* update lobby UI */ });
session.on("lifecycle:results", (rankings) => { /* tally stats, show results */ });
```

---

## 4. Library improvements surfaced by Bomberman

### 4.1 `node-game-ecs`

| Improvement | Priority | Description |
|-------------|----------|-------------|
| Dirty tracking | High | Required for ECS-aware diffing (§2.2) |
| `world.snapshot()` / `world.applySnapshot()` | High | Required for rollback |
| `world.flushDiffs()` / `world.applyDiff()` | High | Required for wire protocol integration |
| Component registry with serializers | High | Required for codec bridging (§2.3) |
| Diff policy hooks | Medium | Optimization for high-frequency components (§2.4) |
| Entity archetypes / prefabs | Low | Convenience for spawning common entity patterns (player, bomb, blast) |

### 4.2 `node-game-server`

| Improvement | Priority | Description |
|-------------|----------|-------------|
| `GameLogicECS` interface | High | Alternative to plain-state `GameLogic` that exposes the ECS World directly |
| ECS diff consumption in `NetworkAdapter` | High | Replace JSON-level diffing with `world.flushDiffs()` |
| Match config injection | High | Accept player manifest + match config at startup, for spawner model (§3) |
| Match result reporting | High | On match end, emit results to parent process / control channel (§3.4) |
| Configurable diff policies | Medium | Per-component control over diff frequency (§2.4) |

### 4.3 `node-game-client`

| Improvement | Priority | Description |
|-------------|----------|-------------|
| ECS-aware state reconciliation | High | Apply diffs via `world.applyDiff()` instead of full state replacement |
| Rollback via ECS snapshots | High | Store/restore ECS world state for prediction correction |
| Configurable interpolation per component | Medium | Some components interpolate (Position), others snap (PlayerStatus) |

### 4.4 `node-game-renderer`

| Improvement | Priority | Description |
|-------------|----------|-------------|
| Direct scene population API | Medium | Populate layers programmatically without Tiled JSON, for proc-gen maps |
| Pixel-perfect scaling mode | Low | Built-in `imageSmoothingEnabled = false` + integer scaling + letterboxing |
| Layer caching controls | Low | Explicit dirty/clean flag per layer to skip redraws (ground layer optimization) |

### 4.5 `node-game-input-manager`

| Improvement | Priority | Description |
|-------------|----------|-------------|
| Intent remapping at runtime | Medium | Swap direction intents for illness effects without rebuilding bindings |
| Custom intent definitions | Low | Allow games to define intents beyond the built-in 28 (currently sufficient) |

---

## 5. Future-proofing considerations

The libraries should remain game-agnostic. Some design constraints to keep in mind for future projects (without over-engineering now):

- **Large worlds with spatial partitioning:** The ECS diff system should support scoped queries (e.g., "entities within viewport") so the server can send only relevant diffs per client. Not needed for Bomberman (single screen), but essential for scrollable maps. The diff format should not assume all clients see all entities.
- **Deformable terrain:** The tile map and renderer should support per-tile mutations at runtime, not just static layers. The ECS could model terrain tiles as entities with mutable components, or the tile map could have its own diff/patch format separate from the entity system. TBD — park this for the future project.
- **Multiple render layers with parallax/depth:** The renderer's `Layer` system already supports z-ordering. Parallax scrolling (different scroll rates per layer) would be a Camera enhancement. Keep the Camera API open for this.
- **Team-based modes:** The session manager should not assume free-for-all. Player metadata should support a `team` field, and win conditions should be pluggable.

---

## 6. Implementation priority

For the Bomberman project, the implementation order is:

1. **`node-game-ecs`** — Add dirty tracking, `flushDiffs()`, `applyDiff()`, `snapshot()`, `applySnapshot()`, component registry.
2. **`node-game-server`** — Add `GameLogicECS` interface, wire the ECS diffs into `NetworkAdapter`. Add match config injection and result reporting for spawner model.
3. **`node-game-client`** — Add ECS-aware reconciliation and rollback.
4. **`node-game-session`** (new) — Session manager with lobby, lifecycle state machine, `GameServerSpawner` interface, `ChildProcessSpawner` for v1. Stats store interface.
5. **`node-game-renderer`** — Direct scene population API for proc-gen maps.
6. **`node-game-input-manager`** — Runtime intent remapping for illness effects.

Items 1–3 are the critical path (ECS ↔ wire protocol integration). Item 4 can be developed in parallel — for early Bomberman development, a simplified inline session manager (no spawner, game server in-process) can be used, then migrated to the full spawner model.

---

*This is a living document. It will be updated as library work progresses and new requirements surface.*
