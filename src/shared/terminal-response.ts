export const TerminalResponse = {
  FocusIn: '\x1b[I',
  FocusOut: '\x1b[O',
  PrimaryDeviceAttributes: '\x1b[?1;2c',
} as const;

export type TerminalResponse = (typeof TerminalResponse)[keyof typeof TerminalResponse];

export function isTerminalResponse(value: unknown): value is TerminalResponse {
  return value === TerminalResponse.FocusIn
    || value === TerminalResponse.FocusOut
    || value === TerminalResponse.PrimaryDeviceAttributes;
}
