import type { WriteBatcher } from './write-batcher';
import { isTerminalResponse, type TerminalResponse } from '../../shared/terminal-response';

export function routeTerminalData(
  data: string,
  userInputBatcher: WriteBatcher,
  writeTerminalResponse: (response: TerminalResponse) => void,
): void {
  if (isTerminalResponse(data)) {
    // xterm parser response（focus report、DA1）不是人類輸入，不能取消 pending delivery 或增加 input generation。
    // 先送出已排隊的人類 bytes，才能讓 response 依 FIFO 順序回到 PTY。
    userInputBatcher.flush();
    writeTerminalResponse(data);
    return;
  }
  userInputBatcher.schedule(data);
}
