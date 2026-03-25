import { BehaviorSubject, Subject } from "rxjs";

/**
 * @enum {string}
 */
export const StartCondition = /** @type {const} */ ({
  /** All players must be ready. */
  ALL_READY: "ALL_READY",
  /** The lobby leader starts manually (all players still must be ready). */
  LEADER_START: "LEADER_START",
});

/**
 * @typedef {Object} LobbyPlayer
 * @property {string} playerId
 * @property {string} displayName
 * @property {boolean} ready
 * @property {boolean} isLeader
 */

/**
 * Lobby — manages the set of connected players and their ready state.
 *
 * Observables:
 * - `players$`       — BehaviorSubject of the current player list
 * - `playerAdded$`   — emits `{ player }` when a player joins
 * - `playerRemoved$` — emits `{ playerId }` when a player leaves
 * - `readyChanged$`  — emits `{ playerId, ready }` when ready state changes
 */
export class Lobby {
  /** @type {Map<string, LobbyPlayer>} */
  #players = new Map();

  /** @type {number} */
  #minPlayers;

  /** @type {number} */
  #maxPlayers;

  /** @type {string} */
  #startCondition;

  /** @type {BehaviorSubject<LobbyPlayer[]>} */
  #players$ = new BehaviorSubject(/** @type {LobbyPlayer[]} */ ([]));

  /** @type {Subject<{ player: LobbyPlayer }>} */
  #playerAdded$ = new Subject();

  /** @type {Subject<{ playerId: string }>} */
  #playerRemoved$ = new Subject();

  /** @type {Subject<{ playerId: string, ready: boolean }>} */
  #readyChanged$ = new Subject();

  /**
   * @param {Object} opts
   * @param {number} opts.minPlayers
   * @param {number} opts.maxPlayers
   * @param {string} [opts.startCondition]
   */
  constructor({ minPlayers, maxPlayers, startCondition = StartCondition.ALL_READY }) {
    this.#minPlayers = minPlayers;
    this.#maxPlayers = maxPlayers;
    this.#startCondition = startCondition;
  }

  /** Observable of the current player list. Emits current value on subscribe. */
  get players$() {
    return this.#players$.asObservable();
  }

  /** Observable of player-added events. */
  get playerAdded$() {
    return this.#playerAdded$.asObservable();
  }

  /** Observable of player-removed events. */
  get playerRemoved$() {
    return this.#playerRemoved$.asObservable();
  }

  /** Observable of ready-state change events. */
  get readyChanged$() {
    return this.#readyChanged$.asObservable();
  }

  /**
   * Push a fresh snapshot of the player list to `players$`.
   * @private
   */
  #emitPlayers() {
    this.#players$.next(Array.from(this.#players.values()));
  }

  /**
   * Add a player to the lobby.
   * @param {string} playerId
   * @param {string} displayName
   * @returns {LobbyPlayer}
   */
  addPlayer(playerId, displayName) {
    if (this.#players.has(playerId)) {
      throw new Error(`Player ${playerId} is already in the lobby`);
    }
    if (this.#players.size >= this.#maxPlayers) {
      throw new Error("Lobby is full");
    }
    const isLeader = this.#players.size === 0;
    /** @type {LobbyPlayer} */
    const player = { playerId, displayName, ready: false, isLeader };
    this.#players.set(playerId, player);
    this.#emitPlayers();
    this.#playerAdded$.next({ player });
    return player;
  }

  /**
   * Remove a player from the lobby.
   * @param {string} playerId
   */
  removePlayer(playerId) {
    const player = this.#players.get(playerId);
    if (!player) return;
    this.#players.delete(playerId);
    if (player.isLeader && this.#players.size > 0) {
      this._electLeader();
    }
    this.#emitPlayers();
    this.#playerRemoved$.next({ playerId });
  }

  /**
   * Mark a player as ready.
   * @param {string} playerId
   */
  setReady(playerId) {
    const player = this.#players.get(playerId);
    if (!player) throw new Error(`Unknown player ${playerId}`);
    if (!player.ready) {
      player.ready = true;
      this.#emitPlayers();
      this.#readyChanged$.next({ playerId, ready: true });
    }
  }

  /**
   * Mark a player as not ready.
   * @param {string} playerId
   */
  setUnready(playerId) {
    const player = this.#players.get(playerId);
    if (!player) throw new Error(`Unknown player ${playerId}`);
    if (player.ready) {
      player.ready = false;
      this.#emitPlayers();
      this.#readyChanged$.next({ playerId, ready: false });
    }
  }

  /**
   * Get all players as an array.
   * @returns {LobbyPlayer[]}
   */
  getPlayers() {
    return Array.from(this.#players.values());
  }

  /**
   * Whether the configured start condition is satisfied.
   * @returns {boolean}
   */
  isStartConditionMet() {
    if (this.#players.size < this.#minPlayers) return false;
    for (const p of this.#players.values()) {
      if (!p.ready) return false;
    }
    return true;
  }

  /**
   * Reset all players' ready flags to false.
   */
  resetReady() {
    for (const p of this.#players.values()) {
      p.ready = false;
    }
    this.#emitPlayers();
  }

  /**
   * Build a player manifest for the game server spawn message.
   * @returns {import("../protocol/controlChannel.js").PlayerManifestEntry[]}
   */
  buildPlayerManifest() {
    return this.getPlayers().map((p) => ({
      playerId: p.playerId,
      displayName: p.displayName,
    }));
  }

  /**
   * Elect the first remaining player as leader.
   * @private
   */
  _electLeader() {
    const first = this.#players.values().next().value;
    if (first) {
      first.isLeader = true;
    }
  }

  /** Complete all subjects and release resources. */
  dispose() {
    this.#playerAdded$.complete();
    this.#playerRemoved$.complete();
    this.#readyChanged$.complete();
    this.#players$.complete();
  }
}
