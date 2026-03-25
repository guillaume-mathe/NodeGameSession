/**
 * @typedef {Object} GameServerInstance
 * @property {string} matchId
 * @property {number} port
 * @property {string} host
 * @property {import("rxjs").Observable<unknown>} controlMessages$ — observable stream of control-channel messages from the server
 * @property {unknown} [handle] — implementation-specific process/container handle
 */

/**
 * @typedef {Object} SpawnConfig
 * @property {string} matchId
 * @property {import("../protocol/controlChannel.js").PlayerManifestEntry[]} players
 * @property {number} tickRateHz
 * @property {Record<string, unknown>} [gameConfig]
 */

/**
 * Abstract base class for game server spawners.
 *
 * Concrete implementations handle a specific deployment topology
 * (child process, container, remote machine, etc.).
 */
export class GameServerSpawner {
  /**
   * Spawn a game server instance.
   * @param {SpawnConfig} _config
   * @returns {Promise<GameServerInstance>}
   */
  async spawn(_config) {
    throw new Error("Not implemented");
  }

  /**
   * Send a control-channel message to a running game server.
   * @param {GameServerInstance} _instance
   * @param {unknown} _message
   */
  send(_instance, _message) {
    throw new Error("Not implemented");
  }

  /**
   * Shut down a running game server instance.
   * @param {GameServerInstance} _instance
   * @returns {Promise<void>}
   */
  async shutdown(_instance) {
    throw new Error("Not implemented");
  }
}
