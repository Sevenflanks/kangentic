export const TerminalFocusReport = {
  FocusIn: '\x1b[I',
  FocusOut: '\x1b[O',
} as const;

export type TerminalFocusReport = (typeof TerminalFocusReport)[keyof typeof TerminalFocusReport];

export function isTerminalFocusReport(value: unknown): value is TerminalFocusReport {
  return value === TerminalFocusReport.FocusIn || value === TerminalFocusReport.FocusOut;
}
