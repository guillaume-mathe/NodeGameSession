import { describe, it, expect, beforeEach, vi } from "vitest";
import { CTRL_SPAWN, CTRL_SHUTDOWN } from "../src/protocol/controlChannel.js";

// Mock child_process.fork
const mockChild = {
  send: vi.fn(),
  kill: vi.fn(),
  on: vi.fn(),
  listeners: {},
};

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    // Reset listeners on each fork call
    mockChild.listeners = {};
    mockChild.on.mockImplementation((event, cb) => {
      if (!mockChild.listeners[event]) mockChild.listeners[event] = [];
      mockChild.listeners[event].push(cb);
      return mockChild;
    });
    mockChild.send.mockClear();
    mockChild.kill.mockClear();
    return mockChild;
  }),
}));

// Must import after mock is set up
const { ChildProcessSpawner } = await import(
  "../src/spawner/ChildProcessSpawner.js"
);
const { fork } = await import("node:child_process");

describe("ChildProcessSpawner", () => {
  /** @type {ChildProcessSpawner} */
  let spawner;

  const config = {
    matchId: "match-1",
    players: [
      { playerId: "p1", displayName: "Alice" },
      { playerId: "p2", displayName: "Bob" },
    ],
    tickRateHz: 20,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    spawner = new ChildProcessSpawner({
      modulePath: "./game-server.js",
      basePort: 9100,
      host: "127.0.0.1",
    });
  });

  it("spawn() forks a child process and sends CTRL_SPAWN", async () => {
    const instance = await spawner.spawn(config);

    expect(fork).toHaveBeenCalledWith("./game-server.js", [], expect.any(Object));
    expect(mockChild.send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: CTRL_SPAWN,
        matchId: "match-1",
        port: 9100,
      }),
    );
    expect(instance.matchId).toBe("match-1");
    expect(instance.port).toBe(9100);
    expect(instance.host).toBe("127.0.0.1");
  });

  it("spawn() increments port for subsequent spawns", async () => {
    const instance1 = await spawner.spawn(config);
    const instance2 = await spawner.spawn({ ...config, matchId: "match-2" });

    expect(instance1.port).toBe(9100);
    expect(instance2.port).toBe(9101);
  });

  it("controlMessages$ emits IPC messages from child", async () => {
    const instance = await spawner.spawn(config);
    const received = [];
    instance.controlMessages$.subscribe((msg) => received.push(msg));

    // Simulate child sending a message via IPC
    const messageHandler = mockChild.listeners["message"][0];
    messageHandler({ kind: "ctrl:ready", matchId: "match-1", port: 9100, host: "127.0.0.1" });

    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("ctrl:ready");
  });

  it("controlMessages$ completes on child exit", async () => {
    const instance = await spawner.spawn(config);
    const completeSpy = vi.fn();
    instance.controlMessages$.subscribe({ complete: completeSpy });

    // Simulate child exit
    const exitHandler = mockChild.listeners["exit"][0];
    exitHandler();

    expect(completeSpy).toHaveBeenCalled();
  });

  it("send() calls child.send()", async () => {
    const instance = await spawner.spawn(config);
    mockChild.send.mockClear();

    spawner.send(instance, { kind: "test" });
    expect(mockChild.send).toHaveBeenCalledWith({ kind: "test" });
  });

  it("send() throws for unknown match", () => {
    expect(() =>
      spawner.send({ matchId: "unknown", port: 0, host: "" }, { kind: "test" }),
    ).toThrow("No child process");
  });

  it("shutdown() sends CTRL_SHUTDOWN", async () => {
    const instance = await spawner.spawn(config);
    mockChild.send.mockClear();

    // Simulate immediate exit after shutdown
    mockChild.on.mockImplementation((event, cb) => {
      if (event === "exit") {
        setTimeout(() => cb(), 0);
      }
      return mockChild;
    });

    await spawner.shutdown(instance);
    expect(mockChild.send).toHaveBeenCalledWith({ kind: CTRL_SHUTDOWN });
  });

  it("shutdown() resolves for unknown instance", async () => {
    await expect(
      spawner.shutdown({ matchId: "unknown", port: 0, host: "" }),
    ).resolves.toBeUndefined();
  });
});
