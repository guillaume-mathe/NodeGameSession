import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Subject } from "rxjs";
import { SessionManager } from "../src/SessionManager.js";
import { LifecycleState } from "../src/lifecycle/LifecycleStateMachine.js";
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
} from "../src/protocol/clientProtocol.js";
import {
  CTRL_READY,
  CTRL_PLAYER_CONNECTED,
  CTRL_MATCH_RESULT,
} from "../src/protocol/controlChannel.js";

// ── Mock WebSocket / WebSocketServer ────────────────────────────────

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  OPEN = 1;
  sent = [];

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

class MockWebSocketServer extends EventEmitter {
  constructor() {
    super();
    // Emit "listening" asynchronously to simulate real WSS
    setTimeout(() => this.emit("listening"), 0);
  }

  close(cb) {
    if (cb) cb();
  }
}

vi.mock("ws", () => ({
  WebSocketServer: vi.fn().mockImplementation(() => new MockWebSocketServer()),
}));

// ── Mock spawner ────────────────────────────────────────────────────

function createMockSpawner() {
  /** @type {Subject<unknown>} */
  let controlMessages$;

  return {
    instance: null,
    controlMessages$: null,
    spawn: vi.fn(async (config) => {
      controlMessages$ = new Subject();
      const instance = {
        matchId: config.matchId,
        port: 9100,
        host: "127.0.0.1",
        controlMessages$: controlMessages$.asObservable(),
      };
      return instance;
    }),
    send: vi.fn(),
    shutdown: vi.fn(async () => {}),
    /** Send a control message to the session manager (simulating game server) */
    emitControl(msg) {
      controlMessages$.next(msg);
    },
    completeControl() {
      controlMessages$.complete();
    },
  };
}

describe("SessionManager", () => {
  /** @type {SessionManager} */
  let session;
  let spawner;

  beforeEach(async () => {
    spawner = createMockSpawner();
    session = new SessionManager({
      minPlayers: 2,
      maxPlayers: 4,
      countdownMs: 100,
      spawner,
      gameLogicModulePath: "./game-logic.js",
    });
    await session.start(0);
  });

  afterEach(async () => {
    await session.shutdown();
  });

  /**
   * Simulate a client connecting and joining the lobby.
   * @param {string} playerId
   * @param {string} displayName
   * @returns {MockWebSocket}
   */
  function connectAndJoin(playerId, displayName) {
    const ws = new MockWebSocket();
    // Trigger the connection event on the mock WSS
    session._handleConnection(ws);
    // Send join message
    ws.emit("message", JSON.stringify({ kind: CLIENT_JOIN, playerId, displayName }));
    return ws;
  }

  // ── Connection & joining ──────────────────────────────────────────

  it("handles CLIENT_JOIN and sends lobby state", () => {
    const ws = connectAndJoin("p1", "Alice");
    const lobbyState = ws.sent.find((m) => m.kind === SESSION_LOBBY_STATE);
    expect(lobbyState).toBeDefined();
    expect(lobbyState.players).toHaveLength(1);
    expect(lobbyState.players[0].playerId).toBe("p1");
    expect(lobbyState.lifecycleState).toBe(LifecycleState.LOBBY);
  });

  it("broadcasts player joined to other clients", () => {
    const ws1 = connectAndJoin("p1", "Alice");
    ws1.sent.length = 0; // Clear initial messages

    const ws2 = connectAndJoin("p2", "Bob");
    const joinMsg = ws1.sent.find((m) => m.kind === SESSION_PLAYER_JOINED);
    expect(joinMsg).toBeDefined();
    expect(joinMsg.player.playerId).toBe("p2");
  });

  it("evicts stale connection on duplicate join", () => {
    const ws1 = connectAndJoin("p1", "Alice");
    const ws2 = new MockWebSocket();
    session._handleConnection(ws2);
    ws2.emit("message", JSON.stringify({ kind: CLIENT_JOIN, playerId: "p1", displayName: "Alice" }));

    // The new connection should receive lobby state (not an error)
    const lobbyState = ws2.sent.find((m) => m.kind === SESSION_LOBBY_STATE);
    expect(lobbyState).toBeDefined();
    expect(lobbyState.players).toHaveLength(1);
    expect(lobbyState.players[0].playerId).toBe("p1");
  });

  // ── Ready state ───────────────────────────────────────────────────

  it("handles CLIENT_READY", () => {
    const ws = connectAndJoin("p1", "Alice");
    ws.emit("message", JSON.stringify({ kind: CLIENT_READY }));

    const players = session.lobby.getPlayers();
    expect(players[0].ready).toBe(true);
  });

  it("handles CLIENT_UNREADY", () => {
    const ws = connectAndJoin("p1", "Alice");
    ws.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws.emit("message", JSON.stringify({ kind: CLIENT_UNREADY }));

    const players = session.lobby.getPlayers();
    expect(players[0].ready).toBe(false);
  });

  // ── CLIENT_LEAVE ──────────────────────────────────────────────────

  it("handles CLIENT_LEAVE", () => {
    const ws = connectAndJoin("p1", "Alice");
    ws.emit("message", JSON.stringify({ kind: CLIENT_LEAVE }));

    expect(session.lobby.getPlayers()).toHaveLength(0);
  });

  // ── Player disconnect ─────────────────────────────────────────────

  it("removes player from lobby on WS close during LOBBY state", () => {
    const ws = connectAndJoin("p1", "Alice");
    ws.close();

    expect(session.lobby.getPlayers()).toHaveLength(0);
  });

  // ── Auto-start match ──────────────────────────────────────────────

  it("auto-starts match when all players ready", async () => {
    const matchStarted = vi.fn();
    session.matchStarted$.subscribe(matchStarted);

    const ws1 = connectAndJoin("p1", "Alice");
    const ws2 = connectAndJoin("p2", "Bob");

    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));

    await vi.waitFor(() => {
      expect(spawner.spawn).toHaveBeenCalled();
    });

    expect(session.lifecycle.state).toBe(LifecycleState.STARTING);
    expect(matchStarted).toHaveBeenCalled();
  });

  // ── Full lifecycle ────────────────────────────────────────────────

  it("runs full lifecycle: join → ready → start → results → lobby", async () => {
    // Re-create session with short results display delay for testing
    await session.shutdown();
    spawner = createMockSpawner();
    session = new SessionManager({
      minPlayers: 2,
      maxPlayers: 4,
      countdownMs: 100,
      resultsDisplayMs: 50,
      spawner,
      gameLogicModulePath: "./game-logic.js",
    });
    await session.start(0);

    const matchStarted = vi.fn();
    const matchEnded = vi.fn();
    session.matchStarted$.subscribe(matchStarted);
    session.matchEnded$.subscribe(matchEnded);

    const ws1 = connectAndJoin("p1", "Alice");
    const ws2 = connectAndJoin("p2", "Bob");

    // Both players ready → auto-start
    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));

    // Wait for spawn to complete
    await vi.waitFor(() => {
      expect(spawner.spawn).toHaveBeenCalled();
    });

    expect(session.lifecycle.state).toBe(LifecycleState.STARTING);
    expect(matchStarted).toHaveBeenCalled();

    // Game server signals ready
    spawner.emitControl({
      kind: CTRL_READY,
      matchId: matchStarted.mock.calls[0][0].matchId,
      port: 9100,
      host: "127.0.0.1",
    });

    expect(session.lifecycle.state).toBe(LifecycleState.SYNC_WAIT);

    // Verify connect-to-game broadcast
    const connectMsg = ws1.sent.find((m) => m.kind === SESSION_CONNECT_TO_GAME);
    expect(connectMsg).toBeDefined();
    expect(connectMsg.port).toBe(9100);

    // Players connect to game server
    spawner.emitControl({
      kind: CTRL_PLAYER_CONNECTED,
      matchId: matchStarted.mock.calls[0][0].matchId,
      playerId: "p1",
    });
    spawner.emitControl({
      kind: CTRL_PLAYER_CONNECTED,
      matchId: matchStarted.mock.calls[0][0].matchId,
      playerId: "p2",
    });

    expect(session.lifecycle.state).toBe(LifecycleState.COUNTDOWN);

    // Wait for countdown to complete
    await vi.waitFor(
      () => {
        expect(session.lifecycle.state).toBe(LifecycleState.PLAYING);
      },
      { timeout: 500 },
    );

    // Game server sends match results
    spawner.emitControl({
      kind: CTRL_MATCH_RESULT,
      matchId: matchStarted.mock.calls[0][0].matchId,
      results: [
        { playerId: "p1", outcome: "win", score: 100 },
        { playerId: "p2", outcome: "loss", score: 50 },
      ],
      durationMs: 60000,
    });

    expect(session.lifecycle.state).toBe(LifecycleState.RESULTS);
    expect(matchEnded).toHaveBeenCalled();

    // Ready state is reset on entering RESULTS, so no manual unready needed.
    // Wait for results display delay (50ms) + cleanup
    await vi.waitFor(() => {
      expect(session.lifecycle.state).toBe(LifecycleState.LOBBY);
    });

    // Verify results broadcast
    const resultsMsg = ws1.sent.find((m) => m.kind === SESSION_MATCH_RESULTS);
    expect(resultsMsg).toBeDefined();
    expect(resultsMsg.results).toHaveLength(2);
  });

  // ── getLobbyState ─────────────────────────────────────────────────

  it("getLobbyState returns current state", () => {
    connectAndJoin("p1", "Alice");
    const state = session.getLobbyState();
    expect(state.players).toHaveLength(1);
    expect(state.lifecycleState).toBe(LifecycleState.LOBBY);
  });

  // ── Error handling ────────────────────────────────────────────────

  it("emits error on invalid JSON message", () => {
    const ws = new MockWebSocket();
    session._handleConnection(ws);
    ws.emit("message", "not-json{{{");

    const errorMsg = ws.sent.find((m) => m.kind === SESSION_ERROR);
    expect(errorMsg).toBeDefined();
  });

  it("emits error on unknown message kind", () => {
    const ws = connectAndJoin("p1", "Alice");
    ws.sent.length = 0;
    ws.emit("message", JSON.stringify({ kind: "unknown:kind" }));

    const errorMsg = ws.sent.find((m) => m.kind === SESSION_ERROR);
    expect(errorMsg).toBeDefined();
    expect(errorMsg.message).toContain("Unknown message kind");
  });

  // ── Game server unexpected exit ───────────────────────────────────

  it("aborts to LOBBY on game server unexpected exit", async () => {
    const ws1 = connectAndJoin("p1", "Alice");
    const ws2 = connectAndJoin("p2", "Bob");

    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));

    await vi.waitFor(() => {
      expect(spawner.spawn).toHaveBeenCalled();
    });

    expect(session.lifecycle.state).toBe(LifecycleState.STARTING);

    // Game server exits unexpectedly
    spawner.completeControl();

    await vi.waitFor(() => {
      expect(session.lifecycle.state).toBe(LifecycleState.LOBBY);
    });
  });

  // ── Stats persistence ─────────────────────────────────────────────

  it("persists stats when statsStore is configured", async () => {
    const mockStats = {
      getOrCreatePlayer: vi.fn(async () => ({
        playerId: "",
        wins: 0,
        losses: 0,
        draws: 0,
        totalPlaytimeMs: 0,
        matchesPlayed: 0,
      })),
      updatePlayerStats: vi.fn(async (id, update) => ({ ...update, playerId: id })),
    };

    await session.shutdown();

    spawner = createMockSpawner();
    session = new SessionManager({
      minPlayers: 2,
      maxPlayers: 4,
      countdownMs: 10,
      resultsDisplayMs: 50,
      spawner,
      gameLogicModulePath: "./game-logic.js",
      statsStore: mockStats,
    });
    await session.start(0);

    const ws1 = connectAndJoin("p1", "Alice");
    const ws2 = connectAndJoin("p2", "Bob");

    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));

    await vi.waitFor(() => expect(spawner.spawn).toHaveBeenCalled());

    spawner.emitControl({
      kind: CTRL_READY,
      matchId: "test-match",
      port: 9100,
      host: "127.0.0.1",
    });
    spawner.emitControl({ kind: CTRL_PLAYER_CONNECTED, matchId: "test-match", playerId: "p1" });
    spawner.emitControl({ kind: CTRL_PLAYER_CONNECTED, matchId: "test-match", playerId: "p2" });

    await vi.waitFor(
      () => expect(session.lifecycle.state).toBe(LifecycleState.PLAYING),
      { timeout: 500 },
    );

    spawner.emitControl({
      kind: CTRL_MATCH_RESULT,
      matchId: "test-match",
      results: [
        { playerId: "p1", outcome: "win", score: 100 },
        { playerId: "p2", outcome: "loss", score: 50 },
      ],
      durationMs: 30000,
    });

    // Ready state is reset on entering RESULTS — no manual unready needed
    await vi.waitFor(() => {
      expect(session.lifecycle.state).toBe(LifecycleState.LOBBY);
    });

    // getOrCreatePlayer is also called on JOIN for stats enrichment (2 calls),
    // plus 2 calls for stats persistence on match end = 4 total
    expect(mockStats.getOrCreatePlayer).toHaveBeenCalledTimes(4);
    expect(mockStats.updatePlayerStats).toHaveBeenCalledTimes(2);
    expect(mockStats.updatePlayerStats).toHaveBeenCalledWith("p1", expect.objectContaining({ wins: 1 }));
    expect(mockStats.updatePlayerStats).toHaveBeenCalledWith("p2", expect.objectContaining({ losses: 1 }));
  });

  // ── Shutdown cleanup ──────────────────────────────────────────────

  it("shutdown() completes observables", async () => {
    const completeSpy = vi.fn();
    session.matchStarted$.subscribe({ complete: completeSpy });

    await session.shutdown();
    expect(completeSpy).toHaveBeenCalled();

    // Re-create for afterEach
    spawner = createMockSpawner();
    session = new SessionManager({
      minPlayers: 2,
      maxPlayers: 4,
      countdownMs: 100,
      spawner,
      gameLogicModulePath: "./game-logic.js",
    });
    await session.start(0);
  });
});

// ── Integration: full lobby loop ───────────────────────────────────

describe("SessionManager — lobby loop integration", () => {
  /** @type {SessionManager} */
  let session;
  let spawner;

  beforeEach(async () => {
    spawner = createMockSpawner();
    session = new SessionManager({
      minPlayers: 2,
      maxPlayers: 4,
      countdownMs: 10,
      resultsDisplayMs: 50,
      spawner,
      gameLogicModulePath: "./game-logic.js",
    });
    await session.start(0);
  });

  afterEach(async () => {
    await session.shutdown();
  });

  function connectAndJoin(playerId, displayName) {
    const ws = new MockWebSocket();
    session._handleConnection(ws);
    ws.emit("message", JSON.stringify({ kind: CLIENT_JOIN, playerId, displayName }));
    return ws;
  }

  /**
   * Drive the state machine from STARTING through to PLAYING.
   * Returns the matchId reported by matchStarted$.
   */
  async function driveToPlaying(ws1, ws2, matchStartedFn) {
    await vi.waitFor(() => expect(spawner.spawn).toHaveBeenCalled());

    const matchId = matchStartedFn.mock.calls.at(-1)[0].matchId;

    // Game server ready → SYNC_WAIT
    spawner.emitControl({ kind: CTRL_READY, matchId, port: 9100, host: "127.0.0.1" });
    expect(session.lifecycle.state).toBe(LifecycleState.SYNC_WAIT);

    // Both players connect → COUNTDOWN
    spawner.emitControl({ kind: CTRL_PLAYER_CONNECTED, matchId, playerId: "p1" });
    spawner.emitControl({ kind: CTRL_PLAYER_CONNECTED, matchId, playerId: "p2" });
    expect(session.lifecycle.state).toBe(LifecycleState.COUNTDOWN);

    // Wait for countdown → PLAYING
    await vi.waitFor(
      () => expect(session.lifecycle.state).toBe(LifecycleState.PLAYING),
      { timeout: 500 },
    );

    return matchId;
  }

  /** Emit match results from the game server. */
  function endMatch(matchId) {
    spawner.emitControl({
      kind: CTRL_MATCH_RESULT,
      matchId,
      results: [
        { playerId: "p1", outcome: "win", score: 1 },
        { playerId: "p2", outcome: "loss", score: 0 },
      ],
      durationMs: 10000,
    });
  }

  // ── Scenario 1: timer expires, no one readies → stays in LOBBY ───

  it("returns to LOBBY after results timeout without auto-starting", async () => {
    const matchStarted = vi.fn();
    session.matchStarted$.subscribe(matchStarted);

    const ws1 = connectAndJoin("p1", "Alice");
    const ws2 = connectAndJoin("p2", "Bob");

    // Ready → start → play
    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    const matchId = await driveToPlaying(ws1, ws2, matchStarted);

    // End the match
    endMatch(matchId);
    expect(session.lifecycle.state).toBe(LifecycleState.RESULTS);

    // Nobody readies — wait for results display timeout
    await vi.waitFor(() => {
      expect(session.lifecycle.state).toBe(LifecycleState.LOBBY);
    });

    // Should NOT have auto-started a second match
    expect(matchStarted).toHaveBeenCalledTimes(1);

    // Players should be unready
    const players = session.lobby.getPlayers();
    expect(players.every((p) => !p.ready)).toBe(true);
  });

  // ── Scenario 2: all players ready during RESULTS → skip timer ────

  it("skips results timer when all players re-ready during RESULTS", async () => {
    const matchStarted = vi.fn();
    session.matchStarted$.subscribe(matchStarted);

    const ws1 = connectAndJoin("p1", "Alice");
    const ws2 = connectAndJoin("p2", "Bob");

    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    const matchId = await driveToPlaying(ws1, ws2, matchStarted);

    endMatch(matchId);
    expect(session.lifecycle.state).toBe(LifecycleState.RESULTS);

    // Both players re-ready during RESULTS
    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));

    // Should immediately transition past LOBBY into a new match
    await vi.waitFor(() => {
      expect(matchStarted).toHaveBeenCalledTimes(2);
    });
  });

  // ── Scenario 3: lobby state broadcasts include lifecycle state ───

  it("broadcasts correct lifecycleState in lobby state during RESULTS", async () => {
    const matchStarted = vi.fn();
    session.matchStarted$.subscribe(matchStarted);

    const ws1 = connectAndJoin("p1", "Alice");
    const ws2 = connectAndJoin("p2", "Bob");

    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    const matchId = await driveToPlaying(ws1, ws2, matchStarted);

    ws1.sent.length = 0;
    endMatch(matchId);

    // A player readies during RESULTS — lobby state should say "RESULTS"
    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));

    const lobbyMsg = ws1.sent.find(
      (m) => m.kind === SESSION_LOBBY_STATE && m.lifecycleState === "RESULTS",
    );
    expect(lobbyMsg).toBeDefined();
  });

  // ── Scenario 4: two consecutive matches ──────────────────────────

  it("plays two full matches back-to-back", async () => {
    const matchStarted = vi.fn();
    const matchEnded = vi.fn();
    session.matchStarted$.subscribe(matchStarted);
    session.matchEnded$.subscribe(matchEnded);

    const ws1 = connectAndJoin("p1", "Alice");
    const ws2 = connectAndJoin("p2", "Bob");

    // ── Match 1 ──
    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    const matchId1 = await driveToPlaying(ws1, ws2, matchStarted);
    endMatch(matchId1);

    expect(session.lifecycle.state).toBe(LifecycleState.RESULTS);

    // Wait for results timeout → LOBBY
    await vi.waitFor(() => {
      expect(session.lifecycle.state).toBe(LifecycleState.LOBBY);
    });

    expect(matchEnded).toHaveBeenCalledTimes(1);

    // ── Match 2 — re-ready and play again ──
    // Need a fresh spawner for the second match
    spawner.spawn.mockImplementation(async (config) => {
      const ctrl$ = new Subject();
      spawner.emitControl = (msg) => ctrl$.next(msg);
      spawner.completeControl = () => ctrl$.complete();
      return {
        matchId: config.matchId,
        port: 9101,
        host: "127.0.0.1",
        controlMessages$: ctrl$.asObservable(),
      };
    });

    ws1.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    ws2.emit("message", JSON.stringify({ kind: CLIENT_READY }));
    const matchId2 = await driveToPlaying(ws1, ws2, matchStarted);

    expect(matchId2).not.toBe(matchId1);

    endMatch(matchId2);

    await vi.waitFor(() => {
      expect(session.lifecycle.state).toBe(LifecycleState.LOBBY);
    });

    expect(matchStarted).toHaveBeenCalledTimes(2);
    expect(matchEnded).toHaveBeenCalledTimes(2);
  });
});
