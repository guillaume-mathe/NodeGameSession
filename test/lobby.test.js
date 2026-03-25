import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Lobby, StartCondition } from "../src/lobby/Lobby.js";

describe("Lobby", () => {
  /** @type {Lobby} */
  let lobby;

  beforeEach(() => {
    lobby = new Lobby({ minPlayers: 2, maxPlayers: 4 });
  });

  afterEach(() => {
    lobby.dispose();
  });

  // ── addPlayer / removePlayer ──────────────────────────────────────

  it("adds a player and emits via playerAdded$", () => {
    const handler = vi.fn();
    lobby.playerAdded$.subscribe(handler);

    const player = lobby.addPlayer("p1", "Alice");
    expect(player.playerId).toBe("p1");
    expect(player.displayName).toBe("Alice");
    expect(player.ready).toBe(false);
    expect(player.isLeader).toBe(true);
    expect(handler).toHaveBeenCalledWith({ player });
  });

  it("removes a player and emits via playerRemoved$", () => {
    lobby.addPlayer("p1", "Alice");
    const handler = vi.fn();
    lobby.playerRemoved$.subscribe(handler);

    lobby.removePlayer("p1");
    expect(handler).toHaveBeenCalledWith({ playerId: "p1" });
    expect(lobby.getPlayers()).toHaveLength(0);
  });

  it("throws on duplicate player", () => {
    lobby.addPlayer("p1", "Alice");
    expect(() => lobby.addPlayer("p1", "Alice")).toThrow("already in the lobby");
  });

  it("throws when lobby is full", () => {
    for (let i = 0; i < 4; i++) {
      lobby.addPlayer(`p${i}`, `Player ${i}`);
    }
    expect(() => lobby.addPlayer("p4", "Extra")).toThrow("Lobby is full");
  });

  it("silently ignores removing unknown player", () => {
    const handler = vi.fn();
    lobby.playerRemoved$.subscribe(handler);
    lobby.removePlayer("unknown");
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Leader election ───────────────────────────────────────────────

  it("first player becomes leader", () => {
    const p1 = lobby.addPlayer("p1", "Alice");
    const p2 = lobby.addPlayer("p2", "Bob");
    expect(p1.isLeader).toBe(true);
    expect(p2.isLeader).toBe(false);
  });

  it("re-elects leader when leader leaves", () => {
    lobby.addPlayer("p1", "Alice");
    lobby.addPlayer("p2", "Bob");

    lobby.removePlayer("p1");
    const players = lobby.getPlayers();
    expect(players[0].playerId).toBe("p2");
    expect(players[0].isLeader).toBe(true);
  });

  // ── Ready state ───────────────────────────────────────────────────

  it("setReady emits readyChanged$", () => {
    lobby.addPlayer("p1", "Alice");
    const handler = vi.fn();
    lobby.readyChanged$.subscribe(handler);

    lobby.setReady("p1");
    expect(handler).toHaveBeenCalledWith({ playerId: "p1", ready: true });
  });

  it("setUnready emits readyChanged$", () => {
    lobby.addPlayer("p1", "Alice");
    lobby.setReady("p1");
    const handler = vi.fn();
    lobby.readyChanged$.subscribe(handler);

    lobby.setUnready("p1");
    expect(handler).toHaveBeenCalledWith({ playerId: "p1", ready: false });
  });

  it("setReady is idempotent (no double emit)", () => {
    lobby.addPlayer("p1", "Alice");
    lobby.setReady("p1");
    const handler = vi.fn();
    lobby.readyChanged$.subscribe(handler);

    lobby.setReady("p1");
    expect(handler).not.toHaveBeenCalled();
  });

  it("setUnready is idempotent (no double emit)", () => {
    lobby.addPlayer("p1", "Alice");
    const handler = vi.fn();
    lobby.readyChanged$.subscribe(handler);

    lobby.setUnready("p1");
    expect(handler).not.toHaveBeenCalled();
  });

  it("throws setReady for unknown player", () => {
    expect(() => lobby.setReady("unknown")).toThrow("Unknown player");
  });

  it("throws setUnready for unknown player", () => {
    expect(() => lobby.setUnready("unknown")).toThrow("Unknown player");
  });

  // ── isStartConditionMet ───────────────────────────────────────────

  it("returns false when not enough players", () => {
    lobby.addPlayer("p1", "Alice");
    lobby.setReady("p1");
    expect(lobby.isStartConditionMet()).toBe(false);
  });

  it("returns false when not all ready", () => {
    lobby.addPlayer("p1", "Alice");
    lobby.addPlayer("p2", "Bob");
    lobby.setReady("p1");
    expect(lobby.isStartConditionMet()).toBe(false);
  });

  it("returns true when min players met and all ready", () => {
    lobby.addPlayer("p1", "Alice");
    lobby.addPlayer("p2", "Bob");
    lobby.setReady("p1");
    lobby.setReady("p2");
    expect(lobby.isStartConditionMet()).toBe(true);
  });

  // ── resetReady ────────────────────────────────────────────────────

  it("resets all players to unready", () => {
    lobby.addPlayer("p1", "Alice");
    lobby.addPlayer("p2", "Bob");
    lobby.setReady("p1");
    lobby.setReady("p2");

    lobby.resetReady();
    const players = lobby.getPlayers();
    expect(players.every((p) => !p.ready)).toBe(true);
  });

  // ── buildPlayerManifest ───────────────────────────────────────────

  it("builds a player manifest", () => {
    lobby.addPlayer("p1", "Alice");
    lobby.addPlayer("p2", "Bob");
    const manifest = lobby.buildPlayerManifest();
    expect(manifest).toEqual([
      { playerId: "p1", displayName: "Alice" },
      { playerId: "p2", displayName: "Bob" },
    ]);
  });

  // ── players$ BehaviorSubject ──────────────────────────────────────

  it("players$ emits current list on subscribe", () => {
    lobby.addPlayer("p1", "Alice");
    const values = [];
    lobby.players$.subscribe((v) => values.push(v));
    expect(values).toHaveLength(1);
    expect(values[0]).toHaveLength(1);
    expect(values[0][0].playerId).toBe("p1");
  });

  it("players$ updates on add/remove", () => {
    const values = [];
    lobby.players$.subscribe((v) => values.push(v));

    lobby.addPlayer("p1", "Alice");
    lobby.addPlayer("p2", "Bob");
    lobby.removePlayer("p1");

    // initial [] + add p1 + add p2 + remove p1
    expect(values).toHaveLength(4);
    expect(values[3]).toHaveLength(1);
    expect(values[3][0].playerId).toBe("p2");
  });

  // ── dispose ───────────────────────────────────────────────────────

  it("dispose() completes subjects", () => {
    const completeSpy = vi.fn();
    lobby.playerAdded$.subscribe({ complete: completeSpy });
    lobby.dispose();
    expect(completeSpy).toHaveBeenCalled();
  });
});
