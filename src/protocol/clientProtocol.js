/**
 * Client protocol — session manager ↔ player WebSocket messages.
 *
 * Prefixes:
 *   CLIENT_*   — sent by the client
 *   SESSION_*  — sent by the session manager
 */

// ── Client → session manager ──────────────────────────────────────

/** Player requests to join the lobby. */
export const CLIENT_JOIN = "client:join";

/** Player marks themselves as ready. */
export const CLIENT_READY = "client:ready";

/** Player marks themselves as not ready. */
export const CLIENT_UNREADY = "client:unready";

/** Player leaves the session. */
export const CLIENT_LEAVE = "client:leave";

// ── Session manager → client ──────────────────────────────────────

/** Full lobby state snapshot (sent on join). */
export const SESSION_LOBBY_STATE = "session:lobby_state";

/** A player joined the lobby. */
export const SESSION_PLAYER_JOINED = "session:player_joined";

/** A player left the lobby. */
export const SESSION_PLAYER_LEFT = "session:player_left";

/** Lifecycle state changed. */
export const SESSION_LIFECYCLE_CHANGE = "session:lifecycle_change";

/** Tells the client to connect to the game server. */
export const SESSION_CONNECT_TO_GAME = "session:connect_to_game";

/** Match results (sent after game ends). */
export const SESSION_MATCH_RESULTS = "session:match_results";

/** Error message. */
export const SESSION_ERROR = "session:error";

// ── JSDoc typedefs ─────────────────────────────────────────────────

/**
 * @typedef {Object} JoinMessage
 * @property {typeof CLIENT_JOIN} kind
 * @property {string} playerId
 * @property {string} displayName
 */

/**
 * @typedef {Object} LobbyPlayer
 * @property {string} playerId
 * @property {string} displayName
 * @property {boolean} ready
 * @property {boolean} isLeader
 */

/**
 * @typedef {Object} LobbyStateMessage
 * @property {typeof SESSION_LOBBY_STATE} kind
 * @property {LobbyPlayer[]} players
 * @property {string} lifecycleState
 */

/**
 * @typedef {Object} PlayerJoinedMessage
 * @property {typeof SESSION_PLAYER_JOINED} kind
 * @property {LobbyPlayer} player
 */

/**
 * @typedef {Object} PlayerLeftMessage
 * @property {typeof SESSION_PLAYER_LEFT} kind
 * @property {string} playerId
 */

/**
 * @typedef {Object} LifecycleChangeMessage
 * @property {typeof SESSION_LIFECYCLE_CHANGE} kind
 * @property {string} state
 */

/**
 * @typedef {Object} ConnectToGameMessage
 * @property {typeof SESSION_CONNECT_TO_GAME} kind
 * @property {string} matchId
 * @property {string} host
 * @property {number} port
 * @property {string} token
 */

/**
 * @typedef {Object} MatchResultsMessage
 * @property {typeof SESSION_MATCH_RESULTS} kind
 * @property {import("./controlChannel.js").PlayerMatchResult[]} results
 * @property {number} durationMs
 */

/**
 * @typedef {Object} ErrorMessage
 * @property {typeof SESSION_ERROR} kind
 * @property {string} message
 */
