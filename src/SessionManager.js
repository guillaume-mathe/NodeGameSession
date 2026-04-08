import { randomUUID } from "node:crypto";
import { Subject, Observable, fromEvent, takeUntil, take } from "rxjs";
import { WebSocketServer } from "ws";
import { LifecycleStateMachine, LifecycleState } from "./lifecycle/LifecycleStateMachine.js";
import { Lobby } from "./lobby/Lobby.js";
import {
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
} from "./protocol/clientProtocol.js";
import {
  CTRL_READY,
  CTRL_PLAYER_CONNECTED,
  CTRL_MATCH_RESULT,
} from "./protocol/controlChannel.js";

/**
 * @typedef {Object} SessionManagerConfig
 * @property {number} minPlayers
 * @property {number} maxPlayers
 * @property {number} [countdownMs=3000]
 * @property {number} [reconnectGraceMs=10000]
 * @property {number} [resultsDisplayMs=20000]
 * @property {import("./stats/StatsStore.js").StatsStore} [statsStore]
 * @property {import("./spawner/GameServerSpawner.js").GameServerSpawner} spawner
 * @property {number} [tickRateHz=20]
 * @property {string} gameLogicModulePath
 * @property {Record<string, unknown>} [gameInstanceConfig]
 */

/**
 * Main session orchestrator.
 *
 * Manages the lobby, lifecycle state machine, game server spawning,
 * and player WebSocket connections.
 *
 * Observables:
 * - `matchStarted$` — emits `{ matchId }` when a match starts
 * - `matchEnded$`   — emits `{ matchId, results }` when a match ends
 * - `error$`        — emits `Error` on errors
 */
export class SessionManager {
  /** @type {SessionManagerConfig} */
  #config;

  /** @type {LifecycleStateMachine} */
  #lifecycle;

  /** @type {Lobby} */
  #lobby;

  /** @type {WebSocketServer | null} */
  #wss = null;

  /** @type {Map<string, import("ws").WebSocket>} */
  #connections = new Map();

  /** @type {string | null} */
  #currentMatchId = null;

  /** @type {import("./spawner/GameServerSpawner.js").GameServerInstance | null} */
  #currentInstance = null;

  /** @type {{ host: string, port: number } | null} */
  #gameServerAddr = null;

  /** @type {import("rxjs").Subscription | null} */
  #controlSub = null;

  /** @type {ReturnType<typeof setTimeout> | null} */
  #countdownTimer = null;

  /** @type {Set<string>} */
  #connectedToGameServer = new Set();

  /** @type {Map<string, import("./stats/StatsStore.js").PlayerStats>} */
  #statsCache = new Map();

  // ── Public observables ────────────────────────────────────────────

  /** @type {Subject<{ matchId: string }>} */
  #matchStarted$ = new Subject();

  /** @type {Subject<{ matchId: string, results: unknown[] }>} */
  #matchEnded$ = new Subject();

  /** @type {Subject<Error>} */
  #error$ = new Subject();

  /** @type {Subject<void>} */
  #destroy$ = new Subject();

  /**
   * @param {SessionManagerConfig} config
   */
  constructor(config) {
    this.#config = {
      countdownMs: 3000,
      reconnectGraceMs: 10000,
      tickRateHz: 20,
      ...config,
    };
    this.#lifecycle = new LifecycleStateMachine();
    this.#lobby = new Lobby({
      minPlayers: config.minPlayers,
      maxPlayers: config.maxPlayers,
    });
  }

  /** The internal lifecycle state machine (read-only access for tests/inspection). */
  get lifecycle() {
    return this.#lifecycle;
  }

  /** The internal lobby (read-only access for tests/inspection). */
  get lobby() {
    return this.#lobby;
  }

  /** Observable that emits when a match starts. */
  get matchStarted$() {
    return this.#matchStarted$.asObservable();
  }

  /** Observable that emits when a match ends. */
  get matchEnded$() {
    return this.#matchEnded$.asObservable();
  }

  /** Observable that emits on errors. */
  get error$() {
    return this.#error$.asObservable();
  }

  /**
   * Start the session manager WebSocket server.
   * @param {number} port
   * @returns {Promise<void>}
   */
  async start(port) {
    this.#wss = new WebSocketServer({ port });

    // Wire up incoming connections (use EventEmitter API to avoid
    // fromEvent's EventTarget detection wrapping args in Event objects)
    const connection$ = new Observable((subscriber) => {
      const handler = (/** @type {import("ws").WebSocket} */ ws) => subscriber.next(ws);
      this.#wss.on("connection", handler);
      return () => this.#wss.off("connection", handler);
    });
    connection$
      .pipe(takeUntil(this.#destroy$))
      .subscribe((ws) => {
        this._handleConnection(ws);
      });

    // Broadcast lifecycle changes to all clients
    this.#lifecycle.transition$
      .pipe(takeUntil(this.#destroy$))
      .subscribe(({ to }) => {
        this._broadcast({ kind: SESSION_LIFECYCLE_CHANGE, state: to });
      });

    // Broadcast player joins
    this.#lobby.playerAdded$
      .pipe(takeUntil(this.#destroy$))
      .subscribe(({ player }) => {
        this._broadcast({ kind: SESSION_PLAYER_JOINED, player });
      });

    // Broadcast player leaves + updated lobby state
    this.#lobby.playerRemoved$
      .pipe(takeUntil(this.#destroy$))
      .subscribe(({ playerId }) => {
        this._broadcast({ kind: SESSION_PLAYER_LEFT, playerId });
        this._broadcastLobbyState();
      });

    // Broadcast updated lobby state + auto-start check on ready changes
    this.#lobby.readyChanged$
      .pipe(takeUntil(this.#destroy$))
      .subscribe(() => {
        this._broadcastLobbyState();
        if (
          this.#lifecycle.state === LifecycleState.LOBBY &&
          this.#lobby.isStartConditionMet()
        ) {
          this._startMatch();
        }
      });

    // Wait for the server to be listening
    return new Promise((resolve) => {
      this.#wss.on("listening", () => resolve());
    });
  }

  /**
   * Gracefully shut down the session manager.
   * @returns {Promise<void>}
   */
  async shutdown() {
    // Signal all takeUntil pipes to unsubscribe
    this.#destroy$.next();
    this.#destroy$.complete();

    // Clear countdown timer
    if (this.#countdownTimer) {
      clearTimeout(this.#countdownTimer);
      this.#countdownTimer = null;
    }

    // Shut down game server if running
    if (this.#currentInstance) {
      this.#controlSub?.unsubscribe();
      this.#controlSub = null;
      try {
        await this.#config.spawner.shutdown(this.#currentInstance);
      } catch {
        // Ignore shutdown errors
      }
      this.#currentInstance = null;
      this.#currentMatchId = null;
    this.#gameServerAddr = null;
    }

    // Close all player connections
    for (const ws of this.#connections.values()) {
      ws.close();
    }
    this.#connections.clear();

    // Close the WSS
    if (this.#wss) {
      await new Promise((resolve) => {
        this.#wss.close(() => resolve());
      });
      this.#wss = null;
    }

    // Dispose lifecycle & lobby subjects
    this.#lifecycle.dispose();
    this.#lobby.dispose();

    // Complete our own subjects
    this.#matchStarted$.complete();
    this.#matchEnded$.complete();
    this.#error$.complete();
  }

  /**
   * Get a snapshot of the current lobby state.
   * @returns {{ players: import("./lobby/Lobby.js").LobbyPlayer[], lifecycleState: string }}
   */
  getLobbyState() {
    return {
      players: this.#lobby.getPlayers(),
      lifecycleState: this.#lifecycle.state,
    };
  }

  /**
   * Handle a new WebSocket connection.
   * @param {import("ws").WebSocket} ws
   * @private
   */
  _handleConnection(ws) {
    const close$ = new Subject();

    // Use the EventEmitter API directly (ws.on) instead of fromEvent()
    // because the ws library's WebSocket implements EventTarget, which
    // causes RxJS fromEvent() to wrap events as MessageEvent objects
    // instead of passing raw data.

    ws.on("close", () => {
      close$.next();
      close$.complete();
      const playerId = this._playerIdForWs(ws);
      if (playerId && this.#lifecycle.state === LifecycleState.LOBBY) {
        this.#lobby.removePlayer(playerId);
        this.#connections.delete(playerId);
      }
    });

    const message$ = new Observable((subscriber) => {
      const handler = (/** @type {import("ws").RawData} */ raw) => subscriber.next(raw);
      ws.on("message", handler);
      return () => ws.off("message", handler);
    });

    message$
      .pipe(takeUntil(close$), takeUntil(this.#destroy$))
      .subscribe((/** @type {import("ws").RawData} */ raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(ws, msg);
        } catch (err) {
          this._sendTo(ws, { kind: SESSION_ERROR, message: "Invalid message format" });
        }
      });
  }

  /**
   * Handle an incoming client message.
   * @param {import("ws").WebSocket} ws
   * @param {unknown} msg
   * @private
   */
  _handleMessage(ws, msg) {
    const data = /** @type {Record<string, unknown>} */ (msg);

    switch (data.kind) {
      case CLIENT_JOIN: {
        const playerId = /** @type {string} */ (data.playerId);

        // If a game is running and this player is part of it, redirect them
        // back to the game server instead of re-adding to the lobby.
        if (this.#lifecycle.state !== LifecycleState.LOBBY && this.#gameServerAddr) {
          const existingWs = this.#connections.get(playerId);
          if (existingWs || this.#connectedToGameServer.has(playerId)) {
            this.#connections.set(playerId, ws);
            this._sendTo(ws, {
              kind: SESSION_CONNECT_TO_GAME,
              matchId: this.#currentMatchId,
              host: this.#gameServerAddr.host,
              port: this.#gameServerAddr.port,
              token: playerId,
            });
            break;
          }
        }

        try {
          // If the player already exists (e.g. page refresh before close fires),
          // evict the stale connection and re-add.
          const existingWs = this.#connections.get(playerId);
          if (existingWs && existingWs !== ws) {
            this.#lobby.removePlayer(playerId);
            this.#connections.delete(playerId);
          }

          const player = this.#lobby.addPlayer(
            playerId,
            /** @type {string} */ (data.displayName),
          );
          this.#connections.set(player.playerId, ws);
          // Fetch stats and broadcast lobby state with stats enrichment
          if (this.#config.statsStore) {
            this.#config.statsStore.getOrCreatePlayer(playerId).then((stats) => {
              this.#statsCache.set(playerId, stats);
              this._broadcastLobbyState();
            }).catch(() => this._broadcastLobbyState());
          } else {
            this._broadcastLobbyState();
          }
        } catch (err) {
          this._sendTo(ws, {
            kind: SESSION_ERROR,
            message: /** @type {Error} */ (err).message,
          });
        }
        break;
      }
      case CLIENT_READY: {
        const playerId = this._playerIdForWs(ws);
        if (playerId) {
          try {
            this.#lobby.setReady(playerId);
          } catch (err) {
            this._sendTo(ws, {
              kind: SESSION_ERROR,
              message: /** @type {Error} */ (err).message,
            });
          }
        }
        break;
      }
      case CLIENT_UNREADY: {
        const playerId = this._playerIdForWs(ws);
        if (playerId) {
          try {
            this.#lobby.setUnready(playerId);
          } catch (err) {
            this._sendTo(ws, {
              kind: SESSION_ERROR,
              message: /** @type {Error} */ (err).message,
            });
          }
        }
        break;
      }
      case CLIENT_LEAVE: {
        const playerId = this._playerIdForWs(ws);
        if (playerId) {
          this.#lobby.removePlayer(playerId);
          this.#connections.delete(playerId);
        }
        ws.close();
        break;
      }
      default:
        this._sendTo(ws, {
          kind: SESSION_ERROR,
          message: `Unknown message kind: ${data.kind}`,
        });
    }
  }

  /**
   * Initiate the match start sequence.
   * @private
   */
  async _startMatch() {
    try {
      this.#lifecycle.transition(LifecycleState.STARTING);
      const matchId = randomUUID();
      this.#currentMatchId = matchId;
      this.#connectedToGameServer.clear();

      const instance = await this.#config.spawner.spawn({
        matchId,
        players: this.#lobby.buildPlayerManifest(),
        tickRateHz: this.#config.tickRateHz,
        gameInstanceConfig: this.#config.gameInstanceConfig,
      });

      this.#currentInstance = instance;

      // Subscribe to control channel messages from the game server
      this.#controlSub = instance.controlMessages$.subscribe({
        next: (msg) => this._handleControlMessage(msg),
        error: (err) => {
          this.#error$.next(err);
          // Game server died unexpectedly — abort back to lobby
          if (this.#lifecycle.state !== LifecycleState.LOBBY) {
            this._abortToLobby("Game server connection lost");
          }
        },
        complete: () => {
          // Game server process exited
          if (
            this.#lifecycle.state !== LifecycleState.LOBBY &&
            this.#lifecycle.state !== LifecycleState.RESULTS
          ) {
            this._abortToLobby("Game server exited unexpectedly");
          }
        },
      });

      this.#matchStarted$.next({ matchId });
    } catch (err) {
      this.#error$.next(/** @type {Error} */ (err));
      // Roll back to lobby on spawn failure
      if (this.#lifecycle.state !== LifecycleState.LOBBY) {
        this.#lifecycle.transition(LifecycleState.LOBBY);
      }
    }
  }

  /**
   * Handle a control-channel message from the game server.
   * @param {unknown} message
   * @private
   */
  _handleControlMessage(message) {
    const msg = /** @type {Record<string, unknown>} */ (message);

    switch (msg.kind) {
      case CTRL_READY: {
        this.#lifecycle.transition(LifecycleState.SYNC_WAIT);
        this.#gameServerAddr = {
          host: /** @type {string} */ (msg.host),
          port: /** @type {number} */ (msg.port),
        };
        // Tell each client to connect to the game server with a per-player token
        for (const [playerId, ws] of this.#connections) {
          this._sendTo(ws, {
            kind: SESSION_CONNECT_TO_GAME,
            matchId: this.#currentMatchId,
            host: this.#gameServerAddr.host,
            port: this.#gameServerAddr.port,
            token: playerId,
          });
        }
        break;
      }
      case CTRL_PLAYER_CONNECTED: {
        this.#connectedToGameServer.add(/** @type {string} */ (msg.playerId));
        const expected = this.#lobby.getPlayers().length;
        if (this.#connectedToGameServer.size >= expected) {
          this.#lifecycle.transition(LifecycleState.COUNTDOWN);
          const countdownMs = this.#config.countdownMs;
          this.#countdownTimer = setTimeout(() => {
            this.#countdownTimer = null;
            if (this.#lifecycle.state === LifecycleState.COUNTDOWN) {
              this.#lifecycle.transition(LifecycleState.PLAYING);
            }
          }, countdownMs);
        }
        break;
      }
      case CTRL_MATCH_RESULT: {
        this._handleMatchResults(msg);
        break;
      }
    }
  }

  /**
   * Handle match results from the game server.
   * @param {unknown} msg
   * @private
   */
  async _handleMatchResults(msg) {
    const data = /** @type {import("./protocol/controlChannel.js").MatchResultMessage} */ (msg);

    this.#lifecycle.transition(LifecycleState.RESULTS);

    // Persist stats if store configured
    if (this.#config.statsStore) {
      try {
        for (const result of data.results) {
          const stats = await this.#config.statsStore.getOrCreatePlayer(result.playerId);
          const update = { matchesPlayed: stats.matchesPlayed + 1 };
          if (result.outcome === "win") update.wins = stats.wins + 1;
          else if (result.outcome === "loss") update.losses = stats.losses + 1;
          else if (result.outcome === "draw") update.draws = stats.draws + 1;
          update.totalPlaytimeMs = stats.totalPlaytimeMs + data.durationMs;
          const updated = await this.#config.statsStore.updatePlayerStats(result.playerId, update);
          this.#statsCache.set(result.playerId, updated);
        }
      } catch (err) {
        this.#error$.next(/** @type {Error} */ (err));
      }
    }

    // Broadcast results to all clients
    this._broadcast({
      kind: SESSION_MATCH_RESULTS,
      results: data.results,
      durationMs: data.durationMs,
    });

    this.#matchEnded$.next({ matchId: data.matchId, results: data.results });

    // Delay before tearing down — give clients time to show the results screen
    const RESULTS_DISPLAY_MS = this.#config.resultsDisplayMs ?? 20000;
    setTimeout(async () => {
      // Clean up game server
      if (this.#currentInstance) {
        this.#controlSub?.unsubscribe();
        this.#controlSub = null;
        try {
          await this.#config.spawner.shutdown(this.#currentInstance);
        } catch {
          // Ignore shutdown errors
        }
        this.#currentInstance = null;
      }
      this.#currentMatchId = null;
      this.#gameServerAddr = null;
      this.#connectedToGameServer.clear();

      // Return to lobby — keep any ready state players set during RESULTS
      this.#lifecycle.transition(LifecycleState.LOBBY);
      this._broadcastLobbyState();
      if (this.#lobby.isStartConditionMet()) {
        this._startMatch();
      }
    }, RESULTS_DISPLAY_MS);
  }

  /**
   * Abort the current match and return to lobby.
   * @param {string} reason
   * @private
   */
  _abortToLobby(reason) {
    if (this.#countdownTimer) {
      clearTimeout(this.#countdownTimer);
      this.#countdownTimer = null;
    }

    this._broadcast({ kind: SESSION_ERROR, message: reason });

    if (this.#currentInstance) {
      this.#controlSub?.unsubscribe();
      this.#controlSub = null;
      this.#currentInstance = null;
    }
    this.#currentMatchId = null;
    this.#gameServerAddr = null;
    this.#connectedToGameServer.clear();
    this.#lobby.resetReady();
    this.#lifecycle.reset();
  }

  /**
   * Broadcast a message to all connected players.
   * @param {unknown} message
   * @private
   */
  _broadcast(message) {
    const data = JSON.stringify(message);
    for (const ws of this.#connections.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  /**
   * Broadcast the lobby state with optional stats enrichment.
   * @private
   */
  _broadcastLobbyState() {
    const players = this.#lobby.getPlayers().map((p) => {
      const stats = this.#statsCache.get(p.playerId);
      if (!stats) return p;
      return { ...p, wins: stats.wins, losses: stats.losses, draws: stats.draws };
    });
    this._broadcast({
      kind: SESSION_LOBBY_STATE,
      players,
      lifecycleState: this.#lifecycle.state,
    });
  }

  /**
   * Send a message to a single WebSocket.
   * @param {import("ws").WebSocket} ws
   * @param {unknown} message
   * @private
   */
  _sendTo(ws, message) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Reverse lookup: find the playerId for a given WebSocket.
   * @param {import("ws").WebSocket} ws
   * @returns {string | undefined}
   * @private
   */
  _playerIdForWs(ws) {
    for (const [id, sock] of this.#connections) {
      if (sock === ws) return id;
    }
    return undefined;
  }
}
