export type LiveDeliveryCancellationReason =
  | 'user-input'
  | 'timeout'
  | 'session-exit'
  | 'turn-error'
  | 'delivery-error'
  | 'superseded'
  | 'shutdown';

export interface LiveDeliveryBase {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly at: string;
}

export type LiveDeliveryStatus = LiveDeliveryBase & (
  | { readonly state: 'waiting' | 'sending' | 'delivered' }
  | { readonly state: 'cancelled'; readonly reason: LiveDeliveryCancellationReason }
);
