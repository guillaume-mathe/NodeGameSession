import { fork } from "node:child_process";
import { Subject } from "rxjs";
import { GameServerSpawner } from "./GameServerSpawner.js";
import { CTRL_SPAWN, CTRL_SHUTDOWN } from "../protocol/controlChannel.js";

/**
 * Spawns game server instances as Node.js child processes on the local machine.
 *
 * Communication uses Node.js IPC (child_process `send` / `on("message")`).
 */
export class ChildProcessSpawner extends GameServerSpawner {
  /** @type {string} */
  #modulePath;

  /** @type {number} */
  #basePort;

  /** @type {string} */
  #host;

  /** @type {Map<string, import("node:child_process").ChildProcess>} */
  #processes = new Map();

  /** @type {Map<string, Subject<unknown>>} */
  #subjects = new Map();

  /** @type {number} */
  #nextPort;

  /**
   * @param {Object} opts
   * @param {string} opts.modulePath — path to the game server entry module
   * @param {number} [opts.basePort=9100]
   * @param {string} [opts.host="127.0.0.1"]
   */
  constructor({ modulePath, basePort = 9100, host = "127.0.0.1" }) {
    super();
    this.#modulePath = modulePath;
    this.#basePort = basePort;
    this.#host = host;
    this.#nextPort = basePort;
  }

  /**
   * Spawn a game server as a child process with IPC.
   * @param {import("./GameServerSpawner.js").SpawnConfig} config
   * @returns {Promise<import("./GameServerSpawner.js").GameServerInstance>}
   */
  async spawn(config) {
    const port = this.#nextPort++;
    const child = fork(this.#modulePath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    const controlMessages$ = new Subject();

    child.on("message", (msg) => {
      controlMessages$.next(msg);
    });

    child.on("exit", () => {
      controlMessages$.complete();
      this.#processes.delete(config.matchId);
      this.#subjects.delete(config.matchId);
    });

    this.#processes.set(config.matchId, child);
    this.#subjects.set(config.matchId, controlMessages$);

    // Tell the game server to spawn the match
    child.send({
      kind: CTRL_SPAWN,
      matchId: config.matchId,
      players: config.players,
      tickRateHz: config.tickRateHz,
      port,
      gameConfig: config.gameConfig,
    });

    return {
      matchId: config.matchId,
      port,
      host: this.#host,
      controlMessages$: controlMessages$.asObservable(),
      handle: child,
    };
  }

  /**
   * Send a control-channel message to a running game server.
   * @param {import("./GameServerSpawner.js").GameServerInstance} instance
   * @param {unknown} message
   */
  send(instance, message) {
    const child = this.#processes.get(instance.matchId);
    if (!child) {
      throw new Error(`No child process for match ${instance.matchId}`);
    }
    child.send(message);
  }

  /**
   * Shut down a running game server instance.
   * Sends CTRL_SHUTDOWN and waits up to 5 seconds for graceful exit before SIGTERM.
   * @param {import("./GameServerSpawner.js").GameServerInstance} instance
   * @returns {Promise<void>}
   */
  async shutdown(instance) {
    const child = this.#processes.get(instance.matchId);
    if (!child) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, 5000);

      child.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.send({ kind: CTRL_SHUTDOWN });
      } catch {
        // Child already dead
        clearTimeout(timeout);
        this.#processes.delete(instance.matchId);
        this.#subjects.delete(instance.matchId);
        resolve();
      }
    });
  }
}
