import type { WriteBatcher } from './write-batcher';
import { isTerminalFocusReport, type TerminalFocusReport } from '../../shared/terminal-focus-report';

export function routeTerminalData(
  data: string,
  userInputBatcher: WriteBatcher,
  writeFocusReport: (report: TerminalFocusReport) => void,
): void {
  if (isTerminalFocusReport(data)) {
    // xterm 公開 onData 會回報 parser 產生的 DEC focus response；不可當成人類輸入取消 pending delivery，
    // 但仍必須依原順序送到 PTY，所以先同步送出已排隊的人類 bytes。
    userInputBatcher.flush();
    writeFocusReport(data);
    return;
  }
  userInputBatcher.schedule(data);
}
