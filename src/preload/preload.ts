import { contextBridge, ipcRenderer } from 'electron';

type PresentMode = 'present-scroll' | 'present-slides';
type Aspect = '4:3' | '16:9';

export type PresentInit = {
  docPath: string | null;
  markdown: string;
  initialMode: PresentMode;
  aspect: Aspect;
};

contextBridge.exposeInMainWorld('markflow', {
  docOpen: () => ipcRenderer.invoke('doc:open'),
  docSave: (args: { docPath: string | null; markdown: string }) => ipcRenderer.invoke('doc:save', args),
  docSetMarkdown: (args: { docPath: string | null; markdown: string }) => ipcRenderer.send('doc:setMarkdown', args),

  presentOpen: (payload: {
    docPath: string | null;
    markdown: string;
    initialMode: PresentMode;
    aspect: Aspect;
    displayTarget?: 'auto' | 'external' | 'primary';
  }) => ipcRenderer.send('present:open', payload),
  presentClose: () => ipcRenderer.send('present:close'),

  presentSetMode: (payload: { mode: PresentMode }) => ipcRenderer.send('present:setMode', payload),
  presentSetAspect: (payload: { aspect: Aspect }) => ipcRenderer.send('present:setAspect', payload),
  presentScrollTo: (payload: unknown) => ipcRenderer.send('present:scrollTo', payload),
  presentSetSlide: (payload: { index: number }) => ipcRenderer.send('present:setSlide', payload),

  onDocUpdate: (cb: (payload: { docPath: string | null; markdown: string }) => void) => {
    const handler = (_: unknown, payload: { docPath: string | null; markdown: string }) => cb(payload);
    ipcRenderer.on('doc:update', handler);
    return () => ipcRenderer.removeListener('doc:update', handler);
  },
  onDocSaved: (cb: (payload: { docPath: string | null }) => void) => {
    const handler = (_: unknown, payload: { docPath: string | null }) => cb(payload);
    ipcRenderer.on('doc:saved', handler);
    return () => ipcRenderer.removeListener('doc:saved', handler);
  },

  onPresentInit: (cb: (payload: PresentInit) => void) => {
    const handler = (_: unknown, payload: PresentInit) => cb(payload);
    ipcRenderer.on('present:init', handler);
    return () => ipcRenderer.removeListener('present:init', handler);
  },
  onPresentSetMode: (cb: (payload: { mode: PresentMode }) => void) => {
    const handler = (_: unknown, payload: { mode: PresentMode }) => cb(payload);
    ipcRenderer.on('present:setMode', handler);
    return () => ipcRenderer.removeListener('present:setMode', handler);
  },
  onPresentSetAspect: (cb: (payload: { aspect: Aspect }) => void) => {
    const handler = (_: unknown, payload: { aspect: Aspect }) => cb(payload);
    ipcRenderer.on('present:setAspect', handler);
    return () => ipcRenderer.removeListener('present:setAspect', handler);
  },
  onPresentScrollTo: (cb: (payload: any) => void) => {
    const handler = (_: unknown, payload: any) => cb(payload);
    ipcRenderer.on('present:scrollTo', handler);
    return () => ipcRenderer.removeListener('present:scrollTo', handler);
  },
  onPresentSetSlide: (cb: (payload: { index: number }) => void) => {
    const handler = (_: unknown, payload: { index: number }) => cb(payload);
    ipcRenderer.on('present:setSlide', handler);
    return () => ipcRenderer.removeListener('present:setSlide', handler);
  }
});
