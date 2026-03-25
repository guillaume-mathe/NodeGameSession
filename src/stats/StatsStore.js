/**
 * @typedef {Object} PlayerStats
 * @property {string} playerId
 * @property {number} wins
 * @property {number} losses
 * @property {number} draws
 * @property {number} totalPlaytimeMs
 * @property {number} matchesPlayed
 */

/**
 * Abstract base class for stats persistence.
 *
 * Concrete implementations may back this with a database, file, or in-memory store.
 */
export class StatsStore {
  /**
   * Get stats for a player.
   * @param {string} _playerId
   * @returns {Promise<PlayerStats | null>}
   */
  async getPlayer(_playerId) {
    throw new Error("Not implemented");
  }

  /**
   * Create a new player stats record with zeroed counters.
   * @param {string} _playerId
   * @returns {Promise<PlayerStats>}
   */
  async createPlayer(_playerId) {
    throw new Error("Not implemented");
  }

  /**
   * Update a player's stats (merges partial updates).
   * @param {string} _playerId
   * @param {Partial<PlayerStats>} _update
   * @returns {Promise<PlayerStats>}
   */
  async updatePlayerStats(_playerId, _update) {
    throw new Error("Not implemented");
  }

  /**
   * Get stats for a player, creating a new record if none exists.
   * @param {string} playerId
   * @returns {Promise<PlayerStats>}
   */
  async getOrCreatePlayer(playerId) {
    const existing = await this.getPlayer(playerId);
    if (existing) return existing;
    return this.createPlayer(playerId);
  }
}
