import { EventEmitter } from "node:events";

/**
 * @enum {string}
 */
export const LifecycleState = /** @type {const} */ ({
  LOBBY: "LOBBY",
  STARTING: "STARTING",
  SYNC_WAIT: "SYNC_WAIT",
  COUNTDOWN: "COUNTDOWN",
  PLAYING: "PLAYING",
  RESULTS: "RESULTS",
});

/**
 * Allowed transitions — keys are source states, values are arrays of valid targets.
 * @type {Record<string, string[]>}
 */
const TRANSITIONS = {
  [LifecycleState.LOBBY]: [LifecycleState.STARTING],
  [LifecycleState.STARTING]: [LifecycleState.SYNC_WAIT, LifecycleState.LOBBY],
  [LifecycleState.SYNC_WAIT]: [LifecycleState.COUNTDOWN, LifecycleState.LOBBY],
  [LifecycleState.COUNTDOWN]: [LifecycleState.PLAYING, LifecycleState.LOBBY],
  [LifecycleState.PLAYING]: [LifecycleState.RESULTS, LifecycleState.LOBBY],
  [LifecycleState.RESULTS]: [LifecycleState.LOBBY],
};

/**
 * Lifecycle state machine for a game session.
 *
 * Emits:
 * - `"transition"` with `{ from, to }` on every valid transition
 */
export class LifecycleStateMachine extends EventEmitter {
  /** @type {string} */
  #state = LifecycleState.LOBBY;

  /** Current lifecycle state. */
  get state() {
    return this.#state;
  }

  /**
   * Check whether a transition from the current state to `target` is valid.
   * @param {string} target
   * @returns {boolean}
   */
  canTransition(target) {
    const allowed = TRANSITIONS[this.#state];
    return allowed !== undefined && allowed.includes(target);
  }

  /**
   * Transition to `target` if the transition is valid.
   * @param {string} target
   * @throws {Error} if the transition is not allowed.
   */
  transition(target) {
    if (!this.canTransition(target)) {
      throw new Error(
        `Invalid transition: ${this.#state} → ${target}`,
      );
    }
    const from = this.#state;
    this.#state = target;
    this.emit("transition", { from, to: target });
  }

  /** Reset the state machine back to LOBBY. */
  reset() {
    const from = this.#state;
    this.#state = LifecycleState.LOBBY;
    if (from !== LifecycleState.LOBBY) {
      this.emit("transition", { from, to: LifecycleState.LOBBY });
    }
  }
}
