import { contextBridge, ipcRenderer } from 'electron';

// Exposed as window.vibeportal — absent in plain browsers (web mode).
contextBridge.exposeInMainWorld('vibeportal', {
  desktop: true,
  platform: process.platform,
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  hidePet: () => ipcRenderer.send('pet:hide'),
  petMenu: () => ipcRenderer.send('pet:menu'),
  getPetPos: (): Promise<[number, number]> => ipcRenderer.invoke('pet:get-pos'),
  setPetPos: (x: number, y: number) => ipcRenderer.send('pet:set-pos', x, y),
  petDragEnd: () => ipcRenderer.send('pet:drag-end'),
  petResize: (width: number, height: number) => ipcRenderer.send('pet:resize', width, height),
});
