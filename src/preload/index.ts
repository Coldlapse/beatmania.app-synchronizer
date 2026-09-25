// 화면(renderer)에 넘기는 창구. 화면은 Node 에 직접 닿지 않고 이것만 부른다.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (fn: (s: unknown) => void) => {
    ipcRenderer.on('state', (_e, s) => fn(s));
  },
  setToken: (token: string) => ipcRenderer.invoke('token:set', token),
  setLaunchAtLogin: (on: boolean) => ipcRenderer.invoke('settings:launchAtLogin', on),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  openLogs: () => ipcRenderer.invoke('open:logs'),
  openSite: (path: string) => ipcRenderer.invoke('open:site', path),
  openProfile: () => ipcRenderer.invoke('open:profile'),
});
