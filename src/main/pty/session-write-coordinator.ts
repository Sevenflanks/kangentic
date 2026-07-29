import type { WriteQueue } from './write-queue';
import type { TerminalFocusReport } from '../../shared/terminal-focus-report';

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

export type SessionWriteOwnershipErrorCode =
  | 'inactive-automation-lease'
  | 'inactive-user-submission-lease'
  | 'user-submission-already-run'
  | 'uninitialized-session';

export class SessionWriteOwnershipError extends Error {
  readonly name = 'SessionWriteOwnershipError';

  constructor(readonly code: SessionWriteOwnershipErrorCode) {
    super(code);
  }
}

type AutomationOwnership = {
  active: boolean;
  committed: boolean;
  readonly queue: WriteQueue;
};

type UserSubmissionOwnership = {
  active: boolean;
  runStarted: boolean;
  waiting: {
    readonly start: () => void;
    readonly cancel: () => void;
  } | null;
};

type SessionWriteState = {
  readonly sessionGeneration: number;
  inputGeneration: number;
  automation: AutomationOwnership | null;
  userSubmission: UserSubmissionOwnership | null;
  readonly deferredWrites: string[];
  deferredInputDraining: boolean;
};

type WriteQueueLookup = (sessionId: string) => WriteQueue | null;
type UserInputRecorded = (sessionId: string, marker: UserInputMarker) => void;

export class SessionWriteCoordinator {
  private readonly states = new Map<string, SessionWriteState>();
  private nextSessionGeneration = 1;

  constructor(
    private readonly getWriteQueue: WriteQueueLookup,
    private readonly onUserInputRecorded: UserInputRecorded = () => {},
  ) {}

  initialize(sessionId: string): number {
    this.disposeSession(sessionId);
    const sessionGeneration = this.nextSessionGeneration;
    this.nextSessionGeneration += 1;
    this.states.set(sessionId, {
      sessionGeneration,
      inputGeneration: 0,
      automation: null,
      userSubmission: null,
      deferredWrites: [],
      deferredInputDraining: false,
    });
    return sessionGeneration;
  }

  recordUserInput(sessionId: string, data: string, occurredAt: number): UserInputMarker {
    const state = this.requireState(sessionId);
    const automation = state.automation;
    if (automation && !automation.committed) {
      automation.active = false;
      state.automation = null;
    }

    const marker = this.recordInputMarker(sessionId, state, occurredAt);

    if (automation?.committed) {
      state.deferredWrites.push(data);
      return marker;
    }

    this.getWriteQueue(sessionId)?.enqueue(data);
    return marker;
  }

  recordFocusReport(sessionId: string, report: TerminalFocusReport): void {
    const state = this.requireState(sessionId);
    if (state.automation?.committed) {
      state.deferredWrites.push(report);
      return;
    }
    this.getWriteQueue(sessionId)?.enqueue(report);
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

    const isActive = (): boolean => ownership.active
      && this.states.get(sessionId) === state
      && state.automation === ownership;

    const release = (): void => {
      if (!ownership.active) return;
      ownership.active = false;
      if (state.automation !== ownership) return;
      state.automation = null;

      // Automation 一旦送出首 byte 就必須先完成 ownership；release 把 deferred writes 接回同一條 FIFO，
      // 並等 queue 完整 drained 才喚醒 user submission，避免 callback 越過尚未送完的較早 user bytes。
      const deferred = state.deferredWrites.splice(0, state.deferredWrites.length);
      for (const data of deferred) ownership.queue.enqueue(data);
      state.deferredInputDraining = true;
      void ownership.queue.drained().then(() => {
        state.deferredInputDraining = false;
        if (!state.automation?.committed) state.userSubmission?.waiting?.start();
      });
    };

    return {
      sessionId,
      sessionGeneration: state.sessionGeneration,
      inputGeneration: state.inputGeneration,
      write(data: string): Promise<void> {
        if (!isActive()) {
          return Promise.reject(new SessionWriteOwnershipError('inactive-automation-lease'));
        }
        if (data.length === 0) return Promise.resolve();
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

    const ownership: UserSubmissionOwnership = {
      active: true,
      runStarted: false,
      waiting: null,
    };
    state.userSubmission = ownership;
    this.recordInputMarker(sessionId, state, Date.now());

    const isActive = (): boolean => ownership.active
      && this.states.get(sessionId) === state
      && state.userSubmission === ownership;

    const release = (): void => {
      if (!ownership.active) return;
      ownership.active = false;
      const waiting = ownership.waiting;
      ownership.waiting = null;
      waiting?.cancel();
      if (state.userSubmission === ownership) state.userSubmission = null;
    };

    return {
      run<T>(submit: () => Promise<T>): Promise<T> {
        if (!isActive()) {
          return Promise.reject(new SessionWriteOwnershipError('inactive-user-submission-lease'));
        }
        if (ownership.runStarted) {
          return Promise.reject(new SessionWriteOwnershipError('user-submission-already-run'));
        }
        ownership.runStarted = true;

        return new Promise<T>((resolve, reject) => {
          let settled = false;
          const cancel = (): void => {
            if (settled) return;
            settled = true;
            reject(new SessionWriteOwnershipError('inactive-user-submission-lease'));
          };
          const start = (): void => {
            if (settled) return;
            settled = true;
            ownership.waiting = null;
            Promise.resolve()
              .then(() => {
                if (!isActive()) {
                  throw new SessionWriteOwnershipError('inactive-user-submission-lease');
                }
                return submit();
              })
              .then(
                (value) => {
                  release();
                  resolve(value);
                },
                (error) => {
                  release();
                  reject(error);
                },
              );
          };
          ownership.waiting = { start, cancel };
          if (!state.automation?.committed && !state.deferredInputDraining) start();
        });
      },
      release,
    };
  }

  disposeSession(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    if (state.automation) state.automation.active = false;
    state.userSubmission?.waiting?.cancel();
    if (state.userSubmission) state.userSubmission.active = false;
    state.deferredWrites.length = 0;
    this.states.delete(sessionId);
  }

  private recordInputMarker(
    sessionId: string,
    state: SessionWriteState,
    occurredAt: number,
  ): UserInputMarker {
    state.inputGeneration += 1;
    const marker: UserInputMarker = {
      sessionGeneration: state.sessionGeneration,
      inputGeneration: state.inputGeneration,
      occurredAt,
    };
    // WriteQueue 會同步送出第一個 chunk；marker 必須先進 evidence，才可讓同一筆 user bytes admission。
    this.onUserInputRecorded(sessionId, marker);
    return marker;
  }

  private requireState(sessionId: string): SessionWriteState {
    const state = this.states.get(sessionId);
    if (!state) throw new SessionWriteOwnershipError('uninitialized-session');
    return state;
  }
}
