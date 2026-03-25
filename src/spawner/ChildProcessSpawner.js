import { GameServerSpawner } from "./GameServerSpawner.js";

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

  /** @type {Map<string, import("child_process").ChildProcess>} */
  #processes = new Map();

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
   * @param {import("./GameServerSpawner.js").SpawnConfig} _config
   * @param {(message: unknown) => void} _onMessage
   * @returns {Promise<import("./GameServerSpawner.js").GameServerInstance>}
   */
  async spawn(_config, _onMessage) {
    // TODO: fork child process with IPC, wire up onMessage, track in #processes
    throw new Error("Not implemented");
  }

  /**
   * @param {import("./GameServerSpawner.js").GameServerInstance} _instance
   * @param {unknown} _message
   */
  send(_instance, _message) {
    // TODO: look up child process by matchId and call process.send()
    throw new Error("Not implemented");
  }

  /**
   * @param {import("./GameServerSpawner.js").GameServerInstance} _instance
   * @returns {Promise<void>}
   */
  async shutdown(_instance) {
    // TODO: send CTRL_SHUTDOWN, then kill child process
    throw new Error("Not implemented");
  }
}
