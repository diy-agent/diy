const listeners: Record<string, Array<(...a: any[]) => void>> = {};
export const ipcMain = {
  on(channel: string, cb: (...a: any[]) => void) {
    (listeners[channel] ??= []).push(cb);
  },
  removeListener(channel: string, cb: (...a: any[]) => void) {
    listeners[channel] = (listeners[channel] ?? []).filter((x) => x !== cb);
  },
};
export const ipcRenderer = {
  send() {},
  on() {},
  removeListener() {},
};
