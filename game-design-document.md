# Bomberman Clone — Game Design Document

**Version:** 0.1-draft  
**Status:** In design  
**Last updated:** 2026-03-24

---

## 1. Overview

A multiplayer Bomberman / X-Blast clone running in the browser, serving as the first validation game for a set of reusable game engine libraries. Players connect to a server, enter a nickname, join a lobby, and play free-for-all matches on a classic grid-based arena.

### 1.1 Goals

- Validate the ECS architecture, networking (frame diff + rollback), tiled renderer, and input mapper libraries.
- Deliver a playable Bomberman experience: grid movement, bombs, destructible walls, power-ups, elimination.
- Persistent player statistics across sessions (identified by nickname).
- Lobby-based matchmaking with return-to-lobby after each round.

### 1.2 Non-goals (for v1)

- Authentication / account system (nickname-only identification).
- Tournaments, ranked play, or team modes.
- Mobile / touch input (keyboard only for now).
- AI bots.

---

## 2. Architecture

### 2.1 Overview

The game uses an **authoritative server with client-side prediction** model. The server runs the canonical ECS world and game loop. Clients run a local predicted ECS copy and reconcile via rollback when the server state diverges.

**Transport:** WebSocket with Cap'n Proto binary serialization.  
**Rendering:** Canvas 2D tile-based renderer.  
**Runtime:** Node.js server, browser client (ES modules).

```
┌─────────────────────────────────────────────────┐
│  Client (Browser)                               │
│  ┌──────────┐ ┌──────────┐ ┌────────────────┐   │
│  │  Input   │→│ ECS      │→│ Tile renderer  │   │
│  │  mapper  │ │(predicted)│ │ (Canvas 2D)    │   │
│  └──────────┘ └──────────┘ └────────────────┘   │
│       │            ↑ rollback                    │
│       ↓            │                             │
│  ┌─────────────────────────┐                     │
│  │  Network client         │                     │
│  │  (WS + Cap'n Proto)     │                     │
│  └───────────┬─────────────┘                     │
└──────────────│──────────────────────────────────┘
               │ inputs ↑ / ↓ state diffs
┌──────────────│──────────────────────────────────┐
│  Server (Node.js)                               │
│  ┌───────────┴─────────────┐                     │
│  │  Network server         │                     │
│  │  (WS + Cap'n Proto)     │                     │
│  └───────────┬─────────────┘                     │
│       ↓      ↓                                   │
│  ┌────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │ Lobby  │→│ Game loop │→│ ECS (authority)  │   │
│  │ manager│ │ (tick)    │ │                  │   │
│  └────────┘ └──────────┘ └──────────────────┘   │
│                                ↓ systems         │
│       ┌────────────┬───────────┬──────────┐      │
│       │ Movement   │ Bomb/Blast│ Power-ups│      │
│       └────────────┴───────────┴──────────┘      │
│                                                  │
│  ┌──────────────────┐                            │
│  │ Stats store      │  (wins, losses, playtime)  │
│  └──────────────────┘                            │
└──────────────────────────────────────────────────┘
```

### 2.2 Tick model

- **Server tick rate:** 20 ticks/sec (50 ms interval). With free sub-tile movement, this gives 2–3 position updates per tile traversal at base speed, which is sufficient for smooth interpolation. Can be bumped to 30 Hz if responsiveness feels lacking.
- **Client render rate:** 60 fps with interpolation between last two received server states.
- **Input sampling:** Every client frame, buffered and sent once per tick.

### 2.3 Networking protocol

All messages are Cap'n Proto encoded over WebSocket binary frames.

**Client → Server:**

| Message          | Content                              | Frequency       |
|------------------|--------------------------------------|-----------------|
| `JoinLobby`      | nickname                             | Once on connect |
| `StartGame`      | (empty, from lobby leader)           | Once            |
| `PlayerInput`    | tick number, input flags (bitfield)  | Every tick      |

**Server → Client:**

| Message          | Content                                   | Frequency       |
|------------------|-------------------------------------------|-----------------|
| `LobbyState`     | player list, ready status                 | On change       |
| `GameStart`      | map data, player spawn positions, tick 0  | Once            |
| `WorldDiff`      | tick number, entity component diffs       | Every tick      |
| `GameOver`       | rankings, stats delta                     | Once            |

### 2.4 Frame diff & rollback

**Server → Client diffs:** Only changed components are sent each tick. The client applies diffs to its local world state. The diff format is per-entity, per-component, with add/update/remove operations.

**Client prediction:** The client immediately applies local player inputs to its predicted ECS. When the server diff arrives for tick N, the client compares its predicted state at tick N. On mismatch:

1. Roll back local world to last confirmed server state.
2. Re-apply all buffered inputs from tick N+1 to current tick.
3. Snap or interpolate visual position to corrected state.

For Bomberman with free movement, mispredictions are more likely than with grid-locked movement — sub-tile positions can drift due to floating-point timing differences, and wall-slide corrections may diverge. The rollback manager should use a position tolerance threshold (e.g., ±2 pixels) below which corrections are applied as smooth interpolation rather than hard snaps.

---

## 3. Game rules

### 3.1 Arena

- Grid-based map, classic Bomberman layout.
- **Art style:** 16-bit era pixel art, emulating the Amiga aesthetic.
- **Logical resolution:** 358×280 pixels (Amiga overscan). The canvas renders at this resolution and is scaled up (nearest-neighbor) to fit the browser viewport, preserving the crispy pixel look. The 20px HUD strip sits at the top, leaving 358×260 for the arena. The 15×13 grid (300×260px) is horizontally centered with 29px margins on each side — these margins can display arena border decoration or remain black.
- **Tile types:** empty, indestructible wall, destructible block, spawn zone.
- **Tile size:** 20×20 pixels at logical resolution. A 15×13 grid fills 300×260 pixels, leaving a 358×20 strip for the HUD (see §6.4).
- **Player sprites:** 16×24 pixels (slightly taller than one tile). The sprite overflows its tile upward by 4px, giving characters visual presence at this small resolution. Collision is based on the bottom 16×16 area (the "feet"), aligned to the tile grid for bomb placement and blast hit detection.
- **Players:** 2–6 players. Each player is assigned a distinct color (see §5.3). Spawn positions follow the X-Blast 6-player layout: 4 corners + 2 center positions (top-center and bottom-center, offset by one tile from the edge).
- **Map generation:** Procedural. The arena layout (indestructible wall pattern, destructible block placement, spawn safe zones) is generated from a seed. The seed is shared with all clients at `GameStart` for deterministic reconstruction.

**Spawn layout (6 players, 15×13 grid):**

```
S · · · · · · · · · · · · · S
· · · · · · · S · · · · · · ·
· · W · W · W · W · W · W · ·
· · · · · · · · · · · · · · ·
· · W · W · W · W · W · W · ·
· · · · · · · · · · · · · · ·
· · W · W · W · W · W · W · ·
· · · · · · · · · · · · · · ·
· · W · W · W · W · W · W · ·
· · · · · · · · · · · · · · ·
· · W · W · W · W · W · W · ·
· · · · · · · S · · · · · · ·
S · · · · · · · · · · · · · S
```

`S` = spawn (3-tile L-shaped safe zone), `W` = indestructible wall, `·` = empty or destructible block (proc-gen).

### 3.2 Player mechanics

- **Movement:** Free sub-tile movement in 4 directions (X-Blast style). Players move continuously at pixel level, not snapping tile-to-tile. Movement speed is configurable (base: ~4 tiles/sec, i.e. ~80 px/sec at 20px tiles).
- **Tile-slot rounding:** For game logic that operates on the grid (bomb placement, blast collision, power-up pickup), the player's position is rounded to the nearest tile center. A player occupies a tile when their center is within that tile's bounds.
- **Wall collision:** AABB collision against wall tiles. Players slide along walls when moving diagonally into a corner (wall-slide). A "corner assist" nudges the player around corners when they're within a configurable threshold (default: 2px), preventing frustrating near-misses at intersections.
- **Bomb placement:** Drop a bomb on the player's rounded tile. Bomb detonates after a fixed timer (default: 2.5 seconds = 50 ticks at 20Hz).
- **Blast:** Extends in 4 cardinal directions from bomb tile, stopped by indestructible walls. Default range: 2 tiles. Blast spreads at 1 tile per tick (animated propagation).
- **Chain detonation:** A blast reaching a bomb's tile triggers immediate detonation of that bomb.
- **Death:** Player whose rounded tile overlaps an active blast tile is eliminated. Last player standing wins.

### 3.3 Extras system

Extras are hidden inside destructible blocks and revealed when the block is destroyed. Their type is decided at map generation time using a weighted random table per block. The system has two layers: basic extras (direct stat boosts) and special extras (abilities, traps, and status effects).

**Extra assignments are server-only state** — not sent to clients at `GameStart`. The server spawns the `Extra` entity diff only when a block is destroyed and the extra is revealed.

#### 3.3.1 Basic extras (from destroyed blocks)

| Extra      | Icon        | Effect                              | Weight |
|------------|-------------|--------------------------------------|--------|
| *(none)*   | —           | Block was empty                     | 40     |
| **Bomb**   | Bomb        | +1 bomb capacity (no cap)           | 20     |
| **Range**  | Fire        | +1 blast range (max 10)             | 20     |
| **Virus**  | Skull       | Applies a random illness (§3.3.4)   | 10     |
| **Special**| Varies      | Random special effect (§3.3.2)      | 10     |

Weights are tunable and evaluated per block at map init.

#### 3.3.2 Special extras

When a Special extra is picked up, one effect is chosen at random from the categories below. The icon shown on the map indicates the category; the specific effect within is revealed on pickup.

**Movement & mobility** (icon: winged boots)

| Name         | On pickup                        | Special key            | Duration       |
|--------------|----------------------------------|------------------------|----------------|
| `kick`       | Enables kicking bombs on contact | —                      | Permanent      |
| `speed`      | Permanent run mode               | —                      | Permanent      |
| `speed2`     | Run mode + stacking speed boost  | —                      | Permanent      |
| `slow`       | Permanent slow mode              | —                      | Permanent      |
| `teleport`   | Grants teleport ability          | Teleport to random tile| Reusable       |
| `through`    | +1 walk-through-bombs charge     | Toggle on/off          | 64 ticks/charge|
| `ghost`      | Walk through walls               | —                      | 256 ticks      |

**Offensive / bomb control** (icon: detonator)

| Name         | On pickup                        | Special key            | Duration       |
|--------------|----------------------------------|------------------------|----------------|
| `rc`         | Remote detonation of own bombs   | Detonate all own bombs | Permanent      |
| `igniteAll`  | Immediately detonates all own bombs | —                   | Instant        |
| `stop`       | Stop own bombs in place          | Toggle                 | Permanent      |
| `snipe`      | +1 snipe charge                  | Drop + steer + detonate| Per charge     |

**Defensive / survival** (icon: shielded player)

| Name         | On pickup                        | Special key            | Duration       |
|--------------|----------------------------------|------------------------|----------------|
| `invincible` | Invincibility, cures illness     | —                      | 160 ticks      |
| `cloak`      | +320 ticks of cloak energy       | Toggle visibility      | Drains while on|

**Aggressive / area effect** (icon: star)

| Name           | On pickup                         | Special key | Duration       |
|----------------|-----------------------------------|-------------|----------------|
| `stunOthers`   | Stuns all opponents for 64 ticks  | —           | Instant        |
| `longStunned`  | Stuns the PICKER for 64 ticks     | —           | Negative trap  |
| `poison`       | Instant death (unless invincible) | —           | Instant        |
| `swapColor`    | Swap sprite colors with opponents | —           | Visual disruption |
| `swapPosition` | Swap positions with opponents     | —           | Instant        |
| `mayhem`       | Grants kick + permanent run mode  | —           | Permanent combo|
| `junkie`       | Forces random bomb drops          | —           | ~384 ticks     |

**Random / mystery** (icon: question mark)

| Roll (0–9) | Effect              | Nature   |
|------------|----------------------|----------|
| 0–1        | Speed (permanent)    | Positive |
| 2–3        | Poison (instant death)| Negative|
| 4–5        | Invincible (160 ticks)| Positive|
| 6–7        | Long stun (64 ticks) | Negative |
| 8–9        | Air pump (ability)   | Positive |

#### 3.3.3 Death redistribution

When a player dies, their accumulated extras are scattered onto free tiles: bombs above starting minimum, range above starting minimum, and any held special abilities. This keeps the economy alive and makes late-game pickups more interesting.

#### 3.3.4 Illness system (Virus extra)

Picking up a Virus extra applies a random illness for **256 ticks (~12.8 seconds at 20Hz)**. The illness is chosen uniformly from 10 types:

| # | Illness           | Effect                                              |
|---|-------------------|------------------------------------------------------|
| 1 | `illBomb`         | Drops bombs involuntarily at random intervals        |
| 2 | `illSlow`         | Movement speed halved                                |
| 3 | `illRun`          | Forced constant running (hard to control)            |
| 4 | `illMini`         | All bombs have minimal blast range                   |
| 5 | `illEmpty`        | Cannot place bombs                                   |
| 6 | `illInvisible`    | Player becomes invisible (can be advantageous!)      |
| 7 | `illMalfunction`  | Bombs behave erratically                             |
| 8 | `illReverse`      | Controls inverted 180° (up↔down, left↔right)         |
| 9 | `illReverse2`     | Controls rotated 90° (up→right, right→down, etc.)   |
| 10| `illTeleport`     | Randomly teleported every ~32 ticks                  |

**Illness interactions:**
- Illnesses are **contagious** — players infect others on contact.
- Picking up an `invincible` extra cures the current illness.
- The illness timer counts down to zero, then the player returns to their "health" baseline (which may itself be a permanent state like `speed` or `slow`).
- `illInvisible` is the only illness that can be advantageous, adding a stealth element.
- `illReverse` and `illReverse2` are handled client-side: the server sends the illness state, and the client's input mapper remaps directions before sending inputs. This means the server always receives "correct" directional inputs and doesn't need to know about the remapping.

**Note on input mapping:** Illness effects that modify controls (`illReverse`, `illReverse2`) are applied in the client's input mapper layer, remapping the physical directions before packing the input bitfield. The server processes all inputs identically regardless of illness — it only tracks the illness timer and type for synchronization.

### 3.4 Match flow

1. **Lobby:** 2–6 players connected. Any player can signal "ready". When all ready (or lobby leader starts), the game begins.
2. **Countdown:** 3-second countdown, players cannot move.
3. **Round:** Free-for-all until one (or zero) players remain. Eliminated players remain as spectators and continue receiving `WorldDiff` messages until the round ends.
4. **Results:** Winner announced, stats updated. All players (including spectators) return to lobby.

**Reconnection:** If a player disconnects mid-game, their character remains in the arena (vulnerable to blasts). The player can reconnect within a grace period (e.g., 30 seconds) and resume control. After the grace period, the player is considered eliminated. The network library handles reconnection at the transport level — the game layer receives a "player reconnected" event and re-associates the connection with the existing player entity.

**Sudden death:** Deferred to v2. Will likely involve arena shrink (indestructible blocks closing in from the edges on a timer).

### 3.5 Audio

SFX via the Web Audio API. No music for v1.

| Event              | Sound                          |
|--------------------|-------------------------------|
| Bomb placed        | Thud / click                  |
| Bomb detonation    | Explosion                     |
| Blast spread       | Fire whoosh (attenuated)      |
| Player death       | Death cry                     |
| Extra collected    | Chime / ding                  |
| Virus collected    | Negative buzz / splat         |
| Illness contagion  | Sizzle / zap                  |
| Special activated  | Whoosh / power chord          |
| Invincible start   | Rising chime                  |
| Countdown tick     | Beep                          |
| Game over          | Fanfare (winner) / buzzer     |

Audio assets are loaded at game start. Sounds are positional — volume is uniform since the camera shows the full arena, but stereo panning can be applied based on the event's X position relative to the viewport center.

---

## 4. ECS design

### 4.1 Components

| Component          | Fields                                          | Scope      |
|--------------------|------------------------------------------------|------------|
| `Position`         | x, y (float, pixel coords)                    | Shared     |
| `Velocity`         | dx, dy (float, px/tick)                        | Shared     |
| `Sprite`           | tilesetId, frameIndex, layer, facing           | Client     |
| `BombCarrier`      | maxBombs, activeBombs, blastRange, hasKick, hasRC, hasStop, hasSnipe, snipeCharges | Shared |
| `Bomb`             | ownerId, tileX, tileY, fuseTicksRemaining, movingDir | Shared |
| `Blast`            | ownerId, tileX, tileY, direction, age, maxAge  | Shared     |
| `DestructibleBlock`| tileX, tileY                                   | Shared     |
| `HiddenExtra`      | extraType, subType, tileX, tileY               | Server     |
| `Extra`            | extraType, subType, tileX, tileY               | Shared     |
| `Player`           | playerId, alive, colorIdx                      | Shared     |
| `PlayerStatus`     | illness, illnessTimer, invincibleTimer, cloakTimer, ghostTimer, junkieTimer, stunnedTimer, speedMode | Shared |
| `SpecialAbility`   | type, charges, active                          | Shared     |
| `InputState`       | flags (bitfield), tick                         | Server     |
| `Collidable`       | blocking (bool)                                | Shared     |

**Component notes:**
- `HiddenExtra` is server-only — tracks what each destructible block contains. Never sent to clients.
- `Extra` is the visible, collectible entity spawned when a block is destroyed.
- `PlayerStatus` tracks all timed effects (illness, invincibility, cloak, ghost, stun, junkie). The `speedMode` field holds the player's permanent speed state (normal, run, slow).
- `SpecialAbility` tracks the player's currently held special-key ability (teleport, through, cloak toggle, snipe, stop toggle, rc). Only one active at a time — picking up a new one replaces it.
- `BombCarrier.movingDir` on `Bomb` supports kicked bombs (direction of travel, 0 = stationary).

### 4.2 Systems (execution order)

1. **InputSystem** — Reads buffered player inputs for the current tick. If player has an input-remapping illness (`illReverse`, `illReverse2`), the remapping is already applied client-side. Sets `Velocity` direction and magnitude on the player entity, factoring in `speedMode` and illness modifiers (`illSlow`, `illRun`).
2. **MovementSystem** — Applies `Velocity` to `Position` (pixel-level). Performs AABB collision against wall tiles (unless `ghostTimer > 0`), applies wall-slide and corner-assist logic. Moves kicked bombs in their `movingDir`.
3. **IllnessSystem** — Decrements all illness/effect timers on `PlayerStatus`. Handles `illBomb` (random involuntary bomb drops), `illTeleport` (random repositioning every ~32 ticks), `junkie` (forced random bomb drops). When `ghostTimer` expires while player is inside a wall, triggers instant death. Checks player-to-player proximity for illness contagion.
4. **SpecialAbilitySystem** — Processes special-key input: triggers the player's held `SpecialAbility` (teleport, through toggle, cloak toggle, rc detonation, snipe control, stop toggle). Decrements cloak energy when active.
5. **BombPlacementSystem** — On action input, rounds player position to nearest tile. If tile is free and player has bomb capacity (and no `illEmpty` illness), spawns a `Bomb` entity. If player has `illBomb` or `junkie`, spawns bombs involuntarily regardless of input.
6. **BombTimerSystem** — Decrements `fuseTicksRemaining`. At zero (or on RC detonation), creates a `Blast` entity at the bomb's tile (age=0) and removes the `Bomb`. If player has `illMalfunction`, bomb timing is erratic. If `illMini`, blast range is forced to 1.
7. **BlastPropagationSystem** — For each `Blast` entity, if `age < maxAge`, increments `age` and spawns new `Blast` entities on adjacent tiles. Stops at indestructible walls. Triggers chain detonation on other bombs.
8. **BlastDamageSystem** — For each active `Blast` tile with `age >= 1` (1-tick grace period), checks overlap with players (unless `invincibleTimer > 0`) and destructible blocks. Kills players, destroys blocks. If a destroyed block had a `HiddenExtra`, spawns the visible `Extra` entity. Blasts can also destroy uncollected `Extra` entities on the ground.
9. **ExtraCollectionSystem** — If a player's rounded tile matches an `Extra` tile: apply the effect based on `extraType` and `subType` (update `BombCarrier`, `PlayerStatus`, `SpecialAbility`), remove the extra entity. On death, runs the redistribution logic (§3.3.3) to scatter accumulated extras onto free tiles.
10. **BlastDecaySystem** — Removes `Blast` entities whose total lifetime has expired.
11. **WinConditionSystem** — Checks alive player count. If ≤1, triggers game over.

### 4.3 Shared vs client-only

The ECS world runs on both server and client. **Shared** components are serialized and diffed over the network. **Client-only** components (e.g., `Sprite`, animation state) are derived locally from shared state and never sent.

**`PlayerStatus` diff policy:** To avoid sending timer decrements every tick, the server only sends `PlayerStatus` diffs on **state transitions** — illness applied, illness cured, invincibility start/end, cloak toggled, ghost start/expired, stun start/end, etc. The client maintains a local copy of the `PlayerStatus` timers and decrements them locally each tick. On a state transition diff from the server, the client overwrites its local timers with the authoritative values. This keeps bandwidth low (no per-tick timer diffs) while ensuring the client stays in sync on the events that matter. If a rollback occurs, the client restores `PlayerStatus` from the last confirmed server state like any other component.

---

## 5. Lobby & player identity

### 5.1 Nickname-based identity

On first connection, the player sends a `JoinLobby` message with their chosen nickname. The server:

1. Looks up the nickname in the stats store.
2. If found: loads existing player record (returning player).
3. If not found: creates a new player record.
4. Returns the player's ID and stats to the client.

**Collision handling:** If a nickname is already connected (active session), the new connection is rejected with an error.

**Client-side persistence:** The chosen nickname is stored in `localStorage`. On subsequent visits, the nickname input is pre-filled, and the client auto-sends `JoinLobby` with the stored value. The player can clear or change it before connecting.

**Security note:** This is intentionally minimal for v1. No passwords, no tokens. A player can "be" anyone by typing their nickname. Acceptable for a local / friends-only prototype.

### 5.2 Player colors

Each player is assigned a color when they join the lobby, in join order. Colors are fixed for the session and used for sprite palette swaps, HUD indicators, and the lobby player list.

| Slot | Color   | Hex       |
|------|---------|-----------|
| P1   | White   | `#E0E0E0` |
| P2   | Red     | `#D03030` |
| P3   | Blue    | `#3060D0` |
| P4   | Green   | `#30A030` |
| P5   | Yellow  | `#D0C030` |
| P6   | Purple  | `#9030B0` |

Colors are designed for contrast at low resolution on both light and dark arena tile palettes.

### 5.3 Lobby UI

The lobby is rendered as a browser HTML page styled with pixel-art aesthetics — retro palette, pixel font (same family as the in-game HUD), sharp borders, no anti-aliased text. CSS `image-rendering: pixelated` on any decorative elements. The visual language should feel like an extension of the game, not a separate modern UI. It transitions to the pixel-art canvas when the game starts.

**Elements:**

- **Player list:** Shows each connected player's assigned color (swatch), nickname, ready status (✓ / —), and win/loss record from the stats store.
- **Ready toggle:** Button to toggle the local player's ready state. Sends `readyToggle` to the server.
- **Start indicator:** When all players are ready, the lobby leader (first connected player) sees a "Start game" button. Alternatively, the game auto-starts after a short countdown (3s) once all players are ready.
- **Connection info:** Displays the server address / room code for sharing with friends.

**Lobby → Game transition:**

1. **Canvas shown:** When `GameStart` is received, the lobby HTML is hidden and the game canvas is displayed. The arena and HUD are rendered immediately (map is generated from the seed), but player input is disabled.
2. **Sync wait:** The canvas shows a semi-transparent overlay with a centered message: *"Waiting for players…"* (pixel font, large). The server waits for all clients to acknowledge receipt of `GameStart` via a `ClientReady` message. This ensures all players have loaded the map and established the real-time tick stream before gameplay begins. The overlay updates to show which players are connected (e.g., checkmarks next to names).
3. **Countdown:** Once all players have confirmed, the server broadcasts a `CountdownStart` message. The client displays a centered, oversized pixel-font countdown: **3 → 2 → 1 → "START!"**, each lasting 1 second. The arena is fully visible behind the countdown numbers. Players cannot move or place bombs during the countdown.
4. **Round begins:** When "START!" appears, the round timer starts, player input is enabled, and the countdown overlay disappears. The server begins processing `PlayerInput` messages from this tick onward.
5. **Game over → Lobby:** On `GameOver`, a brief results overlay is shown on the canvas (winner, rankings), then the canvas is hidden and the lobby is shown with updated stats.

This requires two additional protocol messages:

| Direction        | Message         | Content                    |
|------------------|-----------------|----------------------------|
| Client → Server  | `ClientReady`   | (empty, confirms map load) |
| Server → Client  | `CountdownStart`| countdownTicks: UInt16     |

### 5.4 Stats store

Persistent storage of player statistics. For v1, any lightweight embedded store that can persist JSON-like documents — SQLite, LevelDB, or similar. The store interface is abstracted so the backend can be swapped without touching game logic.

| Field             | Type      | Description                    |
|-------------------|-----------|--------------------------------|
| `playerId`        | string    | UUID, assigned on first join   |
| `nickname`        | string    | Chosen display name            |
| `wins`            | number    | Total rounds won               |
| `losses`          | number    | Rounds lost (eliminated)       |
| `draws`           | number    | Rounds with no winner          |
| `gamesPlayed`     | number    | Total rounds participated      |
| `totalPlaytimeMs` | number    | Cumulative play time           |
| `lastSeen`        | timestamp | Last connection time           |
| `createdAt`       | timestamp | First connection time          |

---

## 6. Rendering

### 6.1 Tile renderer

Canvas 2D renderer consuming the ECS world state. Renders in layers:

1. **Ground layer** — Floor tiles (static, drawn once then cached to an offscreen canvas).
2. **Block layer** — Walls, destructible blocks. Redrawn only when blocks are destroyed.
3. **Object layer** — Bombs (animated fuse pulse), power-ups (subtle idle animation).
4. **Entity layer** — Players, blasts. Players are drawn sorted by Y position (painter's algorithm) so overlapping sprites layer correctly.
5. **HUD strip** — Fixed 358×20 strip at the top of the canvas (see §6.4).

### 6.2 Sprite sheets

All game graphics use a single (or few) sprite sheet(s) at native logical resolution. No sub-pixel rendering — all draw coordinates are integer-snapped.

**Player sprite:** 16×24 pixels, 4 directions × 3 walk frames + 1 idle frame = 16 frames per color variant. The sprite sheet includes all 6 player color variants (palette-swapped). The bottom 16×16 pixels are the collision footprint; the top 8 pixels are the head/hat, which can overlap wall tops for depth.

**Animation frames:**

| Entity            | Size   | Frames | Notes                          |
|--------------------|--------|--------|-------------------------------|
| Player (per dir)   | 16×24  | 3 walk + 1 idle | 6 palette variants   |
| Bomb               | 20×20  | 4      | Pulsing fuse animation         |
| Blast center       | 20×20  | 3      | Appear → full → fade           |
| Blast directional  | 20×20  | 3      | Per cardinal direction         |
| Blast tip          | 20×20  | 3      | End of blast arm               |
| Power-up           | 16×16  | 2      | Subtle shine/blink             |
| Destructible block | 20×20  | 4      | Intact + 3 destruction frames  |
| Skull (HUD)        | 8×8    | 1      | Death indicator                |

**Blast & destruction timing:**

Each blast tile has a total lifespan of 6 ticks (300ms at 20Hz). The 3 animation frames map to this lifespan as follows:

| Phase    | Ticks | Animation frame | Damage | Description                  |
|----------|-------|-----------------|--------|------------------------------|
| Appear   | 0     | Frame 0         | No     | Grace period (1 tick)        |
| Full     | 1–3   | Frame 1         | Yes    | Active damage, full flames   |
| Fade     | 4–5   | Frame 2         | No     | Fading out, no longer lethal |

The block destruction animation (3 frames: cracking → breaking → crumbled) plays in sync with the blast that destroyed it, starting at blast tick 0 and completing by tick 3. This way the destruction visually coincides with the flames passing over the block, matching the classic Bomberman feel. The block entity is removed at tick 3, potentially revealing a power-up underneath.

Blast propagation adds 1 tile per tick in each direction, so a range-2 blast reaches its full extent at tick 2. Each newly-reached tile starts its own 6-tick lifespan independently, creating a wave effect where the center tile begins fading before the tips have fully appeared. In classic SNES Bomberman, the blast visual lasts roughly 0.5 seconds at 60fps — our 6 ticks at 20Hz (300ms) is slightly faster, which suits the more reactive multiplayer pace.

### 6.3 Visual interpolation

The renderer interpolates between the last two confirmed server positions using the fractional time between ticks. This gives smooth 60fps movement despite the 20Hz tick rate.

```
renderPosition = prevPosition + (currPosition - prevPosition) × interpolationFactor
interpolationFactor = timeSinceLastTick / tickInterval
```

All interpolated positions are rounded to integer pixels before drawing to preserve the crisp pixel-art look.

### 6.4 HUD

The HUD occupies a 358×20 pixel strip at the top of the 358×280 canvas. The arena renders in the remaining 358×260 area below.

**Layout (left to right):**

```
[P1 ][P2 ][P3 ][P4 ][P5 ][P6 ]        [  2:45  ]
 ███  ███  ███  ☠██  ███  ☠██           timer
```

- **Player slots** (left side): Each slot shows the player's assigned color as a small swatch (4×4px), their nickname truncated to ~4 characters, and a skull icon (☠) replacing the swatch if eliminated. Alive players have bright text; dead players are dimmed.
- **Round timer** (right side, right-aligned): Remaining time in `M:SS` format, rendered at the full 20px strip height for visibility. Uses a large pixel font that fills the strip.

**Pixel font:** An existing public-domain pixel font (e.g., Press Start 2P, Silkscreen, or similar) will be used for all HUD text. The font must be legible at 5–8px height for player names and render cleanly at integer scaling.

The HUD is drawn directly on the main canvas, not as a separate HTML overlay, to maintain the pixel-art aesthetic at logical resolution.

### 6.5 Camera & scaling

Fixed camera showing the full arena + HUD. The canvas renders at the logical resolution of 358×280 and is scaled up to fit the browser viewport using nearest-neighbor interpolation (`image-rendering: pixelated` / `imageSmoothingEnabled = false`). Aspect ratio is preserved; the viewport is letterboxed if the browser window doesn't match 358:280.

---

## 7. Input handling

### 7.1 Input mapper

The input mapper abstracts raw keyboard events into game actions:

- **Movement:** Arrow keys or WASD → directional flags. If the player has an input-remapping illness (`illReverse`, `illReverse2`), the remapping is applied here before packing.
- **Action:** Space → bomb placement.
- **Special:** Shift or E → activate held special ability.

Inputs are sampled every frame and packed into a bitfield:

```
bit 0: up
bit 1: down
bit 2: left
bit 3: right
bit 4: action (bomb)
bit 5: special (activate held ability)
```

The bitfield is buffered with the predicted tick number and sent to the server each tick.

### 7.2 Input buffering

The client maintains a ring buffer of recent inputs (last ~60 ticks). This buffer is used for rollback re-simulation when the server corrects a misprediction.

---

## 8. Map format & generation

### 8.1 Procedural generation

Maps are procedurally generated from a seed using a seeded PRNG (e.g., `xoshiro128**` for deterministic cross-platform reproducibility). The indestructible wall pattern is always the same classic alternating grid; only the destructible block placement and power-up assignment vary per seed.

**Generation algorithm:**

1. **Initialize grid** (15×13 = 195 tiles): Fill with empty tiles.
2. **Place border walls:** Ring of indestructible walls around the perimeter.
3. **Place interior walls:** Indestructible wall at every position where both coordinates are even (the classic Bomberman checkerboard pillar pattern). This pattern is fixed and does not vary per seed.
4. **Mark spawn safe zones:** For each of the 6 spawn positions, mark a 3-tile L-shaped area as permanently empty (the spawn tile + 2 adjacent tiles along both axes). These tiles never receive destructible blocks.
5. **Fill destructible blocks:** For each remaining empty tile, place a destructible block with probability = `blockDensity` (default: 0.85). Roll the seeded PRNG per tile.
6. **Ensure connectivity:** After block placement, run a flood-fill from each spawn. If any spawn is completely walled off from all others (no reachable path even after destroying blocks in the way), remove a minimum number of blocks to guarantee that each spawn has at least one destructible-only path toward the center. This is a safety check — at 85% density the L-shaped safe zones and natural gaps almost always provide connectivity, but the check prevents rare degenerate seeds.
7. **Assign power-ups:** For each placed destructible block, roll the seeded PRNG against the weighted drop table (§3.3) to assign a hidden power-up type (or none).

**Tunable parameters (sent in `GameStart`):**

| Parameter       | Default | Description                              |
|-----------------|---------|------------------------------------------|
| `blockDensity`  | 0.85    | Probability of placing a block per eligible tile |

Additional tuning (hardcoded for v1, configurable later): minimum path width between spawns (1 tile), power-up weight table.

### 8.2 Map data format

The `GameStart` message includes:

```json
{
  "seed": 2948571,
  "width": 15,
  "height": 13,
  "tileSize": 20,
  "tileset": "classic_16bit",
  "spawns": [[0,0], [14,0], [0,12], [14,12], [7,1], [7,11]],
  "blockDensity": 0.85
}
```

The client runs the same proc-gen algorithm with the given seed to reconstruct the tile grid locally. The server's authoritative copy includes the hidden power-up assignments (not shared with clients).

---

## 9. Cap'n Proto schema

The schema is split into two layers: **engine library** (game-agnostic networking and ECS diff protocol) and **game implementation** (Bomberman-specific components and messages). Each game built on the engine imports the library schema and defines its own component types.

### 9.1 Engine library schema — `engine.capnp`

This schema is owned by the engine library. It defines the envelope, entity diff structure, and generic hooks that games fill in. The `ComponentDiff` struct uses an `AnyPointer` payload — the engine serializes/deserializes the entity-level framing without knowing what components a game defines. The game layer casts the pointer to its own typed union at read time.

```capnp
@0xb1a4e7f2c3d5e6a8;

# ── Transport envelope ──────────────────────────────────

struct ClientEnvelope {
  # Engine-level framing. The game layer wraps game-specific
  # messages inside the payload.
  union {
    playerInput  @0 :PlayerInput;
    gamePayload  @1 :AnyPointer;   # game casts to its ClientMessage
  }
}

struct ServerEnvelope {
  union {
    worldDiff    @0 :WorldDiff;
    gamePayload  @1 :AnyPointer;   # game casts to its ServerMessage
  }
}

# ── Input ───────────────────────────────────────────────

struct PlayerInput {
  tick   @0 :UInt32;
  flags  @1 :UInt8;   # bitfield, layout defined by the game
}

# ── World diff protocol ────────────────────────────────

struct WorldDiff {
  tick   @0 :UInt32;
  diffs  @1 :List(EntityDiff);
}

struct EntityDiff {
  entityId @0 :UInt32;
  union {
    add    @1 :EntitySnapshot;
    update @2 :List(ComponentDiff);
    remove @3 :Void;
  }
}

struct EntitySnapshot {
  components @0 :List(ComponentDiff);
}

struct ComponentDiff {
  # The engine treats this as opaque — it copies/routes diffs
  # without inspecting the payload. The game layer interprets
  # the componentType and casts the payload.
  componentType @0 :UInt16;
  union {
    set    @1 :AnyPointer;   # game casts to its typed component struct
    remove @2 :Void;
  }
}
```

### 9.2 Game schema — `bomberman.capnp`

This schema is owned by the Bomberman game. It imports the engine schema and defines game-specific messages and component data structs. The `componentType` IDs are a game-level convention — the engine never reads them.

```capnp
@0xc2d3f4a5b6e7f8d9;

using Engine = import "engine.capnp";

# ── Game-specific client messages ──────────────────────

struct ClientMessage {
  union {
    joinLobby    @0 :JoinLobby;
    readyToggle  @1 :Void;
    startGame    @2 :Void;
    leaveLobby   @3 :Void;
    clientReady  @4 :Void;        # confirms GameStart received & map loaded
  }
}

struct JoinLobby {
  nickname @0 :Text;
}

# ── Game-specific server messages ──────────────────────

struct ServerMessage {
  union {
    lobbyState     @0 :LobbyState;
    gameStart      @1 :GameStart;
    gameOver       @2 :GameOver;
    error          @3 :ErrorMsg;
    countdownStart @4 :CountdownStart;
  }
}

struct LobbyState {
  players @0 :List(LobbyPlayer);
}

struct LobbyPlayer {
  playerId @0 :UInt32;
  nickname @1 :Text;
  ready    @2 :Bool;
  wins     @3 :UInt32;
  losses   @4 :UInt32;
  colorIdx @5 :UInt8;    # 0-5, assigned in join order
}

struct ErrorMsg {
  code    @0 :UInt16;
  message @1 :Text;
}

struct GameStart {
  mapData      @0 :MapData;
  players      @1 :List(SpawnInfo);
  tickRate     @2 :UInt16;
  startTick    @3 :UInt32;
}

struct MapData {
  seed         @0 :UInt32;
  width        @1 :UInt16;
  height       @2 :UInt16;
  tileSize     @3 :UInt16;
  tileset      @4 :Text;
  spawns       @5 :List(TileCoord);
  blockDensity @6 :Float32;   # 0.0–1.0, fraction of eligible tiles filled
}

struct TileCoord {
  x @0 :UInt16;
  y @1 :UInt16;
}

struct SpawnInfo {
  playerId @0 :UInt32;
  spawnX   @1 :Float32;
  spawnY   @2 :Float32;
}

struct CountdownStart {
  durationMs @0 :UInt16;    # total countdown duration (default: 3000)
  firstTick  @1 :UInt32;    # tick number at which gameplay begins
}

struct GameOver {
  rankings    @0 :List(PlayerRanking);
  matchTimeMs @1 :UInt32;
}

struct PlayerRanking {
  playerId       @0 :UInt32;
  nickname       @1 :Text;
  rank           @2 :UInt8;
  eliminatedTick @3 :UInt32;
}

# ── Component data structs ─────────────────────────────
# Each struct is the payload for a ComponentDiff.set AnyPointer.
# componentType IDs are listed in section 9.3.

struct PositionData {
  x @0 :Float32;
  y @1 :Float32;
}

struct VelocityData {
  dx @0 :Float32;
  dy @1 :Float32;
}

struct BombCarrierData {
  maxBombs   @0 :UInt8;
  active     @1 :UInt8;
  blastRange @2 :UInt8;
  hasKick    @3 :Bool;
  hasRC      @4 :Bool;
  hasStop    @5 :Bool;
  snipeCharges @6 :UInt8;
}

struct BombData {
  ownerId   @0 :UInt32;
  tileX     @1 :UInt16;
  tileY     @2 :UInt16;
  fuse      @3 :UInt16;
  movingDir @4 :UInt8;    # 0=stationary, 1=up, 2=down, 3=left, 4=right
}

struct BlastData {
  ownerId @0 :UInt32;
  tileX   @1 :UInt16;
  tileY   @2 :UInt16;
  dir     @3 :UInt8;    # 0=center, 1=up, 2=down, 3=left, 4=right
  age     @4 :UInt8;
  maxAge  @5 :UInt8;
}

struct ExtraData {
  extraType @0 :UInt8;    # 0=bomb, 1=range, 2=virus, 3=special
  subType   @1 :UInt8;    # for special: index into special table
  tileX     @2 :UInt16;
  tileY     @3 :UInt16;
}

struct PlayerData {
  playerId @0 :UInt32;
  alive    @1 :Bool;
  colorIdx @2 :UInt8;
}

struct PlayerStatusData {
  illness          @0 :UInt8;   # 0=none, 1-10=illness types
  illnessTimer     @1 :UInt16;
  invincibleTimer  @2 :UInt16;
  cloakTimer       @3 :Int16;   # positive=energy remaining, negative=active (draining)
  ghostTimer       @4 :UInt16;
  junkieTimer      @5 :UInt16;
  stunnedTimer     @6 :UInt16;
  speedMode        @7 :UInt8;   # 0=normal, 1=run, 2=slow
}

struct SpecialAbilityData {
  type    @0 :UInt8;    # enum: 0=none, 1=teleport, 2=through, 3=cloak, 4=rc, 5=stop, 6=snipe
  charges @1 :UInt8;
  active  @2 :Bool;     # currently toggled on
}

struct CollidableData {
  blocking @0 :Bool;
}
```

### 9.3 Component type registry

The `componentType` field in `ComponentDiff` maps to game-specific structs. This mapping lives in the game code, not in the engine:

| ID | Component        | Payload struct        |
|----|------------------|-----------------------|
| 0  | `Position`       | `PositionData`        |
| 1  | `Velocity`       | `VelocityData`        |
| 2  | `BombCarrier`    | `BombCarrierData`     |
| 3  | `Bomb`           | `BombData`            |
| 4  | `Blast`          | `BlastData`           |
| 5  | `Extra`          | `ExtraData`           |
| 6  | `Player`         | `PlayerData`          |
| 7  | `Collidable`     | `CollidableData`      |
| 8  | `PlayerStatus`   | `PlayerStatusData`    |
| 9  | `SpecialAbility` | `SpecialAbilityData`  |

Each game defines its own ID table. The engine routes diffs by `entityId` only — it never inspects `componentType` or the payload.

### 9.4 Schema design rationale

**Library / game split:** The engine schema (`engine.capnp`) owns the transport envelope, input framing, and entity diff protocol. It uses `AnyPointer` at two boundaries: the game message payload (lobby, game start, etc.) and the component data payload inside diffs. This means the engine library can serialize, route, and diff entities without importing any game schema. Each game provides its own `.capnp` file that defines the concrete structs cast from those `AnyPointer` slots.

**Why `AnyPointer` + `componentType` instead of a typed union:** Cap'n Proto unions are closed — you can't extend them from another file. A typed union inside `ComponentDiff` would force the engine to import game-specific types, defeating the split. The `AnyPointer` + `UInt16` tag pattern gives the same runtime safety (the game layer knows the type from the tag and casts accordingly) while keeping the engine schema game-agnostic.

**Schema evolution:** Each component struct can gain new fields independently — Cap'n Proto's zero-copy default semantics mean old clients reading a new struct simply see defaults for unknown fields.

**Bandwidth impact:** For a 6-player Bomberman match at 20Hz, worst-case diff traffic is ~2–4 KB/tick (~40–80 KB/s). The `AnyPointer` framing adds negligible overhead vs. a typed union.

**Note:** `Nickname` is only sent in `GameStart` and `LobbyState`, not in per-tick diffs, to save bandwidth.

---

## 10. Engine library integration

The game is built on five existing TypeScript/ES module libraries. This section maps each library to its role in the Bomberman implementation and notes where the design document's abstractions connect to the library APIs.

### 10.1 Library inventory

| Package | Role | Repository |
|---------|------|------------|
| `node-game-server` | Authoritative server: tick loop, state management, rollback, WebSocket networking, snapshot/delta delivery | [NodeGameServer](https://github.com/guillaume-mathe/NodeGameServer) |
| `node-game-client` | Client networking: sync handshake, state reconciliation, reconnection, action submission | [NodeGameClient](https://github.com/guillaume-mathe/NodeGameClient) |
| `node-game-ecs` | Entity Component System: `World`, `defineComponent`, `query`, `addSystem`, `step` | [NodeGameECS](https://github.com/guillaume-mathe/NodeGameECS) |
| `node-game-renderer` | Canvas 2D rendering: `Scene`/`Layer`/`Sprite` scene graph, `SpriteSheet`, `Camera`, `BitmapRenderer`, tile maps | [NodeGameRenderer](https://github.com/guillaume-mathe/NodeGameRenderer) |
| `node-game-input-manager` | Input mapping: `IntentManager`, keyboard/gamepad → abstract intents with edge detection and debounce | [NodeGameInputManager](https://github.com/guillaume-mathe/NodeGameInputManager) |

All libraries are pure ES modules, zero runtime dependencies, Node >= 22.

### 10.2 Server-side wiring

The server uses `node-game-server`'s `createServer()` factory with the `CapnpEnvelopeCodec`. The Bomberman game logic is provided via the `GameLogic` interface:

- `createInitialState()` — creates the ECS `World` (from `node-game-ecs`), registers all components (`Position`, `Velocity`, `BombCarrier`, `Bomb`, `Blast`, `Extra`, `Player`, `PlayerStatus`, `SpecialAbility`, `Collidable`, `DestructibleBlock`, `HiddenExtra`), and registers all systems in execution order (§4.2).
- `tick(state, actions, ctx)` — maps incoming player actions to ECS component mutations, calls `world.step()`, and returns the new state. The `ctx` provides `frame`, `dtMs`. Actions from clients arrive as the intent-derived action objects (MOVE, BOMB, SPECIAL).
- `onGameEvent(state, event)` — handles `CONNECT` (create player entity, assign color, add to lobby), `DISCONNECT` (mark player eliminated or remove from lobby), `SUSPEND`/`RESUME` (reconnection lifecycle).

The server's `GameStateManager` handles the rollback window. The `NetworkAdapter` delivers snapshot/delta hybrids with per-client ack targeting — this maps directly to the `WorldDiff` concept in §2.4, though the current server library uses its own diff format (JSON or Cap'n Proto) rather than the `engine.capnp` schema described in §9. The Cap'n Proto schema in §9 represents the target wire format; bridging between the library's internal state and the schema is the game layer's responsibility.

**Key mapping — server wire protocol to game protocol:**

| Server library concept | Bomberman game protocol |
|------------------------|-------------------------|
| `sync_request` / `sync_response` / `sync_result` | Clock sync handshake (unchanged, used as-is) |
| `snapshot` (full state) | `GameStart` + initial `WorldDiff` |
| `delta` (frame diff) | `WorldDiff` per tick |
| `game_event` `CONNECT` | Lobby player join |
| `game_event` `SUSPEND` / `RESUME` | Reconnection (30s grace, §3.4) |
| `action` (client → server) | `PlayerInput` (tick + bitfield) |
| `logout` | `LeaveLobby` |

### 10.3 Client-side wiring

The client uses `node-game-client` for networking and `node-game-input-manager` for input.

**Input mapping** — The `IntentManager` is configured with Bomberman-specific bindings:

| Intent | Bomberman action | Input bitfield |
|--------|------------------|----------------|
| `MOVE_UP` | Move up | bit 0 |
| `MOVE_DOWN` | Move down | bit 1 |
| `MOVE_LEFT` | Move left | bit 2 |
| `MOVE_RIGHT` | Move right | bit 3 |
| `PRIMARY` | Place bomb | bit 4 |
| `SECONDARY` | Activate special | bit 5 |

The `poll()` call returns the intent states each frame. For illness remapping (`illReverse`, `illReverse2`), the game layer swaps the intent-to-bitfield mapping before packing — the `IntentManager` always reports raw physical inputs, and the remapping is applied in the game's action translation layer.

**Rendering** — `node-game-renderer` provides the scene graph:

- `Scene` with layers matching §6.1: ground (static, cached), blocks, objects, entities, HUD.
- `SpriteSheet` with grid-based frame definitions for all entities (§6.2).
- `Camera` with fixed position (no follow, arena fits screen), configured for 358×280 logical resolution.
- `BitmapRenderer` targeting the game `<canvas>` with `imageSmoothingEnabled = false`.

The render loop receives interpolated state from `node-game-client` and updates sprite positions/frames each `requestAnimationFrame`. The `alpha` parameter from the client's interpolation drives the lerp between tick states (§6.3).

**ECS on client** — The client runs its own `node-game-ecs` `World` for prediction. It mirrors the server's component definitions and system registrations. On each local tick, the client applies the local player's input and steps the world. When a server diff arrives, the client compares predicted state, and on mismatch, rolls back and re-simulates (§2.4). The `PlayerStatus` component uses transition-only diffs with local timer countdown (§4.3).

### 10.4 Adaptation notes

Several areas require bridging between the current library APIs and the game design. These are tracked in detail in the companion [Library Evolution Plan](./library-evolution-plan.md), which proposes ECS-aware wire protocol diffing (§2), a new `node-game-session` library for lobby/lifecycle management (§3), and per-library improvement tables (§4). The key items for Bomberman are:

- **ECS diff integration:** The ECS `World` should track mutations natively and produce structured diffs, eliminating the `toState()` / `fromState()` serialization bridge. See library plan §2.
- **Session management:** Lobby, countdown, and lifecycle state machine should move to a reusable `node-game-session` library. See library plan §3.
- **Renderer tile map:** The proc-gen map will populate `Scene` layers directly via a programmatic API rather than using the Tiled JSON loader. See library plan §4.4.

---

## 11. Open questions & next steps

- [ ] **Power-up weight tuning:** Current table is a starting point. Needs playtesting to assess balance.
- [ ] **Blast timing tuning:** 6-tick lifespan (300ms) per blast tile is the starting value. May need adjustment.
- [ ] **Pixel font selection:** Evaluate Press Start 2P, Silkscreen, and similar public-domain pixel fonts.
- [ ] **Sound design:** Source or create SFX assets (explosion, fuse, pickup chime, death, countdown beep).

Library evolution items are tracked in the companion [Library Evolution Plan](./library-evolution-plan.md).

---

*This is a living document. Each section will be expanded as design decisions are made.*
