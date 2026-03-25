import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LifecycleStateMachine,
  LifecycleState,
} from "../src/lifecycle/LifecycleStateMachine.js";

describe("LifecycleStateMachine", () => {
  /** @type {LifecycleStateMachine} */
  let sm;

  beforeEach(() => {
    sm = new LifecycleStateMachine();
  });

  it("starts in LOBBY", () => {
    expect(sm.state).toBe(LifecycleState.LOBBY);
  });

  it("allows valid transition LOBBY → STARTING", () => {
    expect(sm.canTransition(LifecycleState.STARTING)).toBe(true);
    sm.transition(LifecycleState.STARTING);
    expect(sm.state).toBe(LifecycleState.STARTING);
  });

  it("rejects invalid transition LOBBY → PLAYING", () => {
    expect(sm.canTransition(LifecycleState.PLAYING)).toBe(false);
    expect(() => sm.transition(LifecycleState.PLAYING)).toThrow(
      "Invalid transition",
    );
  });

  it("emits 'transition' event on valid transition", () => {
    const handler = vi.fn();
    sm.on("transition", handler);
    sm.transition(LifecycleState.STARTING);
    expect(handler).toHaveBeenCalledWith({
      from: LifecycleState.LOBBY,
      to: LifecycleState.STARTING,
    });
  });

  it("does not emit on failed transition", () => {
    const handler = vi.fn();
    sm.on("transition", handler);
    try {
      sm.transition(LifecycleState.PLAYING);
    } catch {
      // expected
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("reset() returns to LOBBY", () => {
    sm.transition(LifecycleState.STARTING);
    sm.reset();
    expect(sm.state).toBe(LifecycleState.LOBBY);
  });

  it("reset() emits transition event", () => {
    sm.transition(LifecycleState.STARTING);
    const handler = vi.fn();
    sm.on("transition", handler);
    sm.reset();
    expect(handler).toHaveBeenCalledWith({
      from: LifecycleState.STARTING,
      to: LifecycleState.LOBBY,
    });
  });

  it("reset() does not emit when already in LOBBY", () => {
    const handler = vi.fn();
    sm.on("transition", handler);
    sm.reset();
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows abort back to LOBBY from any non-LOBBY state", () => {
    // STARTING → LOBBY
    sm.transition(LifecycleState.STARTING);
    expect(sm.canTransition(LifecycleState.LOBBY)).toBe(true);

    // SYNC_WAIT → LOBBY
    sm.reset();
    sm.transition(LifecycleState.STARTING);
    sm.transition(LifecycleState.SYNC_WAIT);
    expect(sm.canTransition(LifecycleState.LOBBY)).toBe(true);
  });

  it("completes a full happy-path lifecycle", () => {
    const transitions = vi.fn();
    sm.on("transition", transitions);

    sm.transition(LifecycleState.STARTING);
    sm.transition(LifecycleState.SYNC_WAIT);
    sm.transition(LifecycleState.COUNTDOWN);
    sm.transition(LifecycleState.PLAYING);
    sm.transition(LifecycleState.RESULTS);
    sm.transition(LifecycleState.LOBBY);

    expect(sm.state).toBe(LifecycleState.LOBBY);
    expect(transitions).toHaveBeenCalledTimes(6);
  });
});
