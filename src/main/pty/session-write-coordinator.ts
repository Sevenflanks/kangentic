import type { WriteQueue } from './write-queue';

export interface SubmissionLease {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly inputGeneration: number;
  write(data: string): Promise<void>;
  release(): void;
}

export interface UserSubmissionLease {
  run<T>(submit: () => Promise<T>): Promise<T>;
  release(): void;
}

export interface OwnershipExpectation {
  readonly sessionGeneration: number;
  readonly inputGeneration: number;
}

export interface UserInputMarker {
  readonly sessionGeneration: number;
  readonly inputGeneration: number;
  readonly occurredAt: number;
}

type AutomationOwnership = {
  active: boolean;
  committed: boolean;
  readonly queue: WriteQueue;
};

type UserSubmissionOwnership = {
  active: boolean;
};

type SessionWriteState = {
  readonly sessionGeneration: number;
  inputGeneration: number;
  automation: AutomationOwnership | null;
  userSubmission: UserSubmissionOwnership | null;
  readonly deferredUserInput: string[];
};

type WriteQueueLookup = (sessionId: string) => WriteQueue | null;

export class SessionWriteCoordinator {
  private readonly states = new Map<string, SessionWriteState>();
  private nextSessionGeneration = 1;

  constructor(private readonly getWriteQueue: WriteQueueLookup) {}

  initialize(sessionId: string): number {
    this.disposeSession(sessionId);
    const sessionGeneration = this.nextSessionGeneration;
    this.nextSessionGeneration += 1;
    this.states.set(sessionId, {
      sessionGeneration,
      inputGeneration: 0,
      automation: null,
      userSubmission: null,
      deferredUserInput: [],
    });
    return sessionGeneration;
  }

  recordUserInput(sessionId: string, data: string, occurredAt: number): UserInputMarker {
    const state = this.requireState(sessionId);
    state.inputGeneration += 1;
    const marker: UserInputMarker = {
      sessionGeneration: state.sessionGeneration,
      inputGeneration: state.inputGeneration,
      occurredAt,
    };

    const automation = state.automation;
    if (automation && !automation.committed) {
      automation.active = false;
      state.automation = null;
    }

    if (automation?.committed) {
      state.deferredUserInput.push(data);
      return marker;
    }

    this.getWriteQueue(sessionId)?.enqueue(data);
    return marker;
  }

  getSessionGeneration(sessionId: string): number | null {
    return this.states.get(sessionId)?.sessionGeneration ?? null;
  }

  getInputGeneration(sessionId: string): number | null {
    return this.states.get(sessionId)?.inputGeneration ?? null;
  }

  acquireAutomation(
    sessionId: string,
    expected: OwnershipExpectation,
    onFirstWrite: () => void,
  ): SubmissionLease | null {
    const state = this.states.get(sessionId);
    if (!state
      || state.automation
      || state.userSubmission
      || state.sessionGeneration !== expected.sessionGeneration
      || state.inputGeneration !== expected.inputGeneration) return null;

    const queue = this.getWriteQueue(sessionId);
    if (!queue) return null;

    const ownership: AutomationOwnership = {
      active: true,
      committed: false,
      queue,
    };
    state.automation = ownership;

    const release = (): void => {
      if (!ownership.active) return;
      ownership.active = false;
      if (state.automation !== ownership) return;
      state.automation = null;

      // Automation 一旦送出首 byte 就必須先完成 ownership；user input 到 release 才接回同一條 FIFO，避免兩邊 byte 交錯。
      const deferred = state.deferredUserInput.splice(0, state.deferredUserInput.length);
      for (const data of deferred) ownership.queue.enqueue(data);
    };

    return {
      sessionId,
      sessionGeneration: state.sessionGeneration,
      inputGeneration: state.inputGeneration,
      write(data: string): Promise<void> {
        if (!ownership.active) return Promise.resolve();
        if (!ownership.committed) {
          ownership.committed = true;
          onFirstWrite();
        }
        return ownership.queue.enqueueAcknowledged(data);
      },
      release,
    };
  }

  acquireUserSubmission(sessionId: string): UserSubmissionLease | null {
    const state = this.states.get(sessionId);
    if (!state || state.userSubmission) return null;

    if (state.automation && !state.automation.committed) {
      state.automation.active = false;
      state.automation = null;
    }

    const ownership: UserSubmissionOwnership = { active: true };
    state.userSubmission = ownership;
    const release = (): void => {
      if (!ownership.active) return;
      ownership.active = false;
      if (state.userSubmission === ownership) state.userSubmission = null;
    };

    return {
      async run<T>(submit: () => Promise<T>): Promise<T> {
        try {
          return await submit();
        } finally {
          release();
        }
      },
      release,
    };
  }

  disposeSession(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    if (state.automation) state.automation.active = false;
    if (state.userSubmission) state.userSubmission.active = false;
    state.deferredUserInput.length = 0;
    this.states.delete(sessionId);
  }

  private requireState(sessionId: string): SessionWriteState {
    const state = this.states.get(sessionId);
    if (!state) throw new Error(`Session write coordination is not initialized: ${sessionId}`);
    return state;
  }
}
