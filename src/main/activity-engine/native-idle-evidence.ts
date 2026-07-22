import type { NativeBoundary } from '../agent/adapters/opencode/native-boundary';

export interface NativeIdleSnapshot {
  readonly rootNativeSessionId: string | null;
  readonly sessionGeneration: number;
  readonly inputGeneration: number;
  readonly cleanIdle: {
    readonly nativeSessionId: string;
    readonly occurredAt: number;
  } | null;
  readonly errorLatched: boolean;
}

type NativeIdleState = {
  rootNativeSessionId: string | null;
  sessionGeneration: number;
  inputGeneration: number;
  cleanIdle: {
    readonly nativeSessionId: string;
    readonly occurredAt: number;
  } | null;
  errorLatched: boolean;
  lastInputAt: number;
};

export class NativeIdleEvidence {
  private readonly states = new Map<string, NativeIdleState>();
  private readonly listeners = new Map<string, Set<() => void>>();

  initializeSession(ptySessionId: string, sessionGeneration: number): void {
    this.states.set(ptySessionId, {
      rootNativeSessionId: null,
      sessionGeneration,
      inputGeneration: 0,
      cleanIdle: null,
      errorLatched: false,
      lastInputAt: Number.NEGATIVE_INFINITY,
    });
    this.notify(ptySessionId);
  }

  recordBoundary(ptySessionId: string, boundary: NativeBoundary): void {
    const state = this.states.get(ptySessionId);
    if (!state) return;

    switch (boundary.kind) {
      case 'created':
        if (state.rootNativeSessionId !== null || boundary.nativeSessionId === null) return;
        state.rootNativeSessionId = boundary.nativeSessionId;
        state.cleanIdle = null;
        state.errorLatched = false;
        break;
      case 'turn-start':
        if (boundary.nativeSessionId === null
          || boundary.nativeSessionId !== state.rootNativeSessionId) return;
        state.cleanIdle = null;
        state.errorLatched = false;
        break;
      case 'idle':
        if (boundary.nativeSessionId === null
          || boundary.nativeSessionId !== state.rootNativeSessionId
          || boundary.occurredAt <= state.lastInputAt
          || state.errorLatched) return;
        state.cleanIdle = {
          nativeSessionId: boundary.nativeSessionId,
          occurredAt: boundary.occurredAt,
        };
        break;
      case 'error':
        if (boundary.nativeSessionId !== null
          && boundary.nativeSessionId !== state.rootNativeSessionId) return;
        state.cleanIdle = null;
        state.errorLatched = true;
        break;
    }

    this.notify(ptySessionId);
  }

  recordUserInput(ptySessionId: string, generation: number, at: number): void {
    const state = this.states.get(ptySessionId);
    if (!state) return;
    state.inputGeneration = generation;
    state.lastInputAt = at;
    state.cleanIdle = null;
    state.errorLatched = false;
    this.notify(ptySessionId);
  }

  subscribe(ptySessionId: string, listener: () => void): () => void {
    let sessionListeners = this.listeners.get(ptySessionId);
    if (!sessionListeners) {
      sessionListeners = new Set();
      this.listeners.set(ptySessionId, sessionListeners);
    }
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
      if (sessionListeners.size === 0) this.listeners.delete(ptySessionId);
    };
  }

  snapshot(ptySessionId: string): NativeIdleSnapshot | null {
    const state = this.states.get(ptySessionId);
    if (!state) return null;
    return {
      rootNativeSessionId: state.rootNativeSessionId,
      sessionGeneration: state.sessionGeneration,
      inputGeneration: state.inputGeneration,
      cleanIdle: state.cleanIdle ? { ...state.cleanIdle } : null,
      errorLatched: state.errorLatched,
    };
  }

  removeSession(ptySessionId: string): void {
    if (!this.states.delete(ptySessionId)) return;
    this.notify(ptySessionId);
  }

  private notify(ptySessionId: string): void {
    const sessionListeners = this.listeners.get(ptySessionId);
    if (!sessionListeners) return;
    for (const listener of sessionListeners) listener();
  }
}
