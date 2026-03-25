import { EventEmitter } from "node:events";
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
 * @property {import("./stats/StatsStore.js").StatsStore} [statsStore]
 * @property {import("./spawner/GameServerSpawner.js").GameServerSpawner} spawner
 * @property {number} [tickRateHz=20]
 * @property {string} gameLogicModulePath
 * @property {Record<string, unknown>} [gameConfig]
 */

/**
 * Main session orchestrator.
 *
 * Manages the lobby, lifecycle state machine, game server spawning,
 * and player WebSocket connections.
 *
 * Emits:
 * - `"matchStarted"`  with `{ matchId }`
 * - `"matchEnded"`    with `{ matchId, results }`
 * - `"error"`         with `Error`
 */
export class SessionManager extends EventEmitter {
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

  /**
   * @param {SessionManagerConfig} config
   */
  constructor(config) {
    super();
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

  /**
   * Start the session manager WebSocket server.
   * @param {number} port
   * @returns {Promise<void>}
   */
  async start(port) {
    // TODO: create WebSocketServer, wire up connection handler
    throw new Error("Not implemented");
  }

  /**
   * Gracefully shut down the session manager.
   * @returns {Promise<void>}
   */
  async shutdown() {
    // TODO: close WS server, shut down any running game server, clean up
    throw new Error("Not implemented");
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
   * @param {import("ws").WebSocket} _ws
   * @private
   */
  _handleConnection(_ws) {
    // TODO: wire up message/close handlers
    throw new Error("Not implemented");
  }

  /**
   * Handle an incoming client message.
   * @param {import("ws").WebSocket} _ws
   * @param {unknown} _data
   * @private
   */
  _handleMessage(_ws, _data) {
    // TODO: parse message, dispatch by kind
    throw new Error("Not implemented");
  }

  /**
   * Initiate the match start sequence.
   * @private
   */
  async _startMatch() {
    // TODO: transition to STARTING, spawn game server, wire control channel
    throw new Error("Not implemented");
  }

  /**
   * Handle a control-channel message from the game server.
   * @param {unknown} _message
   * @private
   */
  _handleControlMessage(_message) {
    // TODO: dispatch CTRL_READY, CTRL_PLAYER_CONNECTED, CTRL_MATCH_RESULT
    throw new Error("Not implemented");
  }

  /**
   * Handle match results from the game server.
   * @param {import("./protocol/controlChannel.js").MatchResultMessage} _msg
   * @private
   */
  async _handleMatchResults(_msg) {
    // TODO: transition to RESULTS, persist stats, broadcast results, return to LOBBY
    throw new Error("Not implemented");
  }

  /**
   * Broadcast a message to all connected players.
   * @param {unknown} _message
   * @private
   */
  _broadcast(_message) {
    // TODO: JSON.stringify and send to all connections
    throw new Error("Not implemented");
  }
}
