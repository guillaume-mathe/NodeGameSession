/**
 * Control channel protocol — session manager ↔ game server IPC messages.
 *
 * For v1 these travel over Node.js child_process IPC.
 * Designed to swap to HTTP / message-queue for distributed deployment.
 */

// ── Message kind constants ─────────────────────────────────────────

/** Session manager → game server: spawn a new match. */
export const CTRL_SPAWN = "ctrl:spawn";

/** Game server → session manager: server is ready to accept player connections. */
export const CTRL_READY = "ctrl:ready";

/** Game server → session manager: a player has connected to the game server. */
export const CTRL_PLAYER_CONNECTED = "ctrl:player_connected";

/** Game server → session manager: match finished, here are the results. */
export const CTRL_MATCH_RESULT = "ctrl:match_result";

/** Session manager → game server: graceful shutdown. */
export const CTRL_SHUTDOWN = "ctrl:shutdown";

/** Either direction: abort the current match immediately. */
export const CTRL_ABORT = "ctrl:abort";

// ── JSDoc typedefs ─────────────────────────────────────────────────

/**
 * @typedef {Object} PlayerManifestEntry
 * @property {string} playerId
 * @property {string} displayName
 */

/**
 * @typedef {Object} SpawnMessage
 * @property {typeof CTRL_SPAWN} kind
 * @property {string} matchId
 * @property {PlayerManifestEntry[]} players
 * @property {number} tickRateHz
 * @property {Record<string, unknown>} [gameConfig]
 */

/**
 * @typedef {Object} ReadyMessage
 * @property {typeof CTRL_READY} kind
 * @property {string} matchId
 * @property {number} port
 * @property {string} host
 */

/**
 * @typedef {Object} PlayerConnectedMessage
 * @property {typeof CTRL_PLAYER_CONNECTED} kind
 * @property {string} matchId
 * @property {string} playerId
 */

/**
 * @typedef {Object} PlayerMatchResult
 * @property {string} playerId
 * @property {"win" | "loss" | "draw"} outcome
 * @property {number} score
 */

/**
 * @typedef {Object} MatchResultMessage
 * @property {typeof CTRL_MATCH_RESULT} kind
 * @property {string} matchId
 * @property {PlayerMatchResult[]} results
 * @property {number} durationMs
 */

/**
 * @typedef {Object} ShutdownMessage
 * @property {typeof CTRL_SHUTDOWN} kind
 */

/**
 * @typedef {Object} AbortMessage
 * @property {typeof CTRL_ABORT} kind
 * @property {string} matchId
 * @property {string} [reason]
 */
