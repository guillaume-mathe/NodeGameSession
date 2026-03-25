# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`node-game-session` is a **session orchestrator library** for multiplayer games. It manages player connections, lobbies, game lifecycle, and stats persistence. It sits above `node-game-server` (which runs individual matches) and spawns game server instances per match.

This is part of a suite of reusable game engine libraries:
- `node-game-server` — authoritative tick loop, state management, rollback, WebSocket
- `node-game-client` — client sync, state reconciliation, reconnection
- `node-game-ecs` — ECS: World, defineComponent, query, systems, dirty tracking, diffs
- `node-game-renderer` — Canvas 2D scene graph, sprite sheets, tile maps, camera
- `node-game-input-manager` — input intent mapping, keyboard/gamepad

The first game built on these libraries is a multiplayer Bomberman clone (see `game-design-document.md`).

## Architecture

### Connection model

Players maintain two WebSocket connections:
1. **Persistent WS to session manager** — lobby, lifecycle events, chat, reconnection routing
2. **Per-match WS to game server** — gameplay ticks, ECS diffs (spawned per match, ephemeral)

### Lifecycle state machine

```
LOBBY → STARTING → SYNC_WAIT → COUNTDOWN → PLAYING → RESULTS → LOBBY
```

- `STARTING`: session manager has decided to start; game server is being spawned
- `SYNC_WAIT`: game server ready; waiting for all clients to connect to it
- Other states map to standard lobby/gameplay phases

### Game server spawning

The library uses a `GameServerSpawner` interface. Concrete implementations handle deployment topology:
- `ChildProcessSpawner` — v1, single machine, Node.js child_process IPC
- Future: `ContainerSpawner`, `RemoteSpawner` for horizontal scaling

### Session ↔ game server control channel

Internal (non-player-facing) protocol: `spawn`, `ready`, `player_connected`, `match_result`, `shutdown`, `abort`. For v1 this is Node.js IPC; designed to swap to HTTP/message queue for distributed deployment.

### Stats persistence

Pluggable `StatsStore` interface for recording match results (wins, losses, playtime).

## Key design documents

- `game-design-document.md` — Full Bomberman game design (rules, ECS components, networking protocol, rendering)
- `library-evolution-plan.md` — Engine library roadmap, ECS-aware wire protocol design, this library's requirements (§3)

## Build & test commands

```bash
npm run build          # esbuild ESM bundle + tsc declarations → dist/
npm run build:bundle   # esbuild only
npm run build:types    # tsc declarations only
npm test               # vitest run (all test/**/*.test.js)
```

## Code conventions

- **Plain JavaScript with JSDoc types** — no TypeScript source files
- esbuild bundles ESM; tsc emits `.d.ts` declarations only
- `platform: "node"`, `ws` and `rxjs` are external (not bundled)
- Matches sibling library pattern (NodeGameECS, NodeGameClient, etc.)
- Use `node:` prefix for Node.js built-in imports (e.g. `node:crypto`)
- Classes use private fields (`#field`) for encapsulation
- Interface/base classes throw `"Not implemented"` from method stubs
- **RxJS conventions**: `BehaviorSubject` for current-value state, `Subject` for events; `$` suffix on observable fields; expose `.asObservable()` via getters; every class with subjects has a `dispose()` method that completes them
- No `EventEmitter` — all event streams use RxJS subjects/observables

## Source structure

```
src/
  index.js                       — barrel exports
  SessionManager.js              — main orchestrator
  lifecycle/
    LifecycleStateMachine.js     — state enum + transition table
  lobby/
    Lobby.js                     — player management, ready state
  protocol/
    controlChannel.js            — session ↔ game server IPC constants/types
    clientProtocol.js            — session ↔ client WS constants/types
  spawner/
    GameServerSpawner.js         — abstract spawner interface
    ChildProcessSpawner.js       — child_process IPC implementation
  stats/
    StatsStore.js                — abstract stats persistence interface
test/
  lifecycle.test.js              — LifecycleStateMachine tests
```
