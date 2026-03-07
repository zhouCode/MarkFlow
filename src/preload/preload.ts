import { contextBridge, ipcRenderer } from 'electron';

export type ShareInit = {
  docPath: string | null;
  markdown: string;
  progress: number;
  zoomScale: number;
};

export type ContentZoomState = {
  scale: number;
};

contextBridge.exposeInMainWorld('markflow', {
  docOpen: () => ipcRenderer.invoke('doc:open'),
  docSave: (args: { docPath: string | null; markdown: string }) => ipcRenderer.invoke('doc:save', args),
  docSetMarkdown: (args: { docPath: string | null; markdown: string }) => ipcRenderer.send('doc:setMarkdown', args),

  contentZoomIn: () => ipcRenderer.send('contentZoom:adjust', 'in'),
  contentZoomOut: () => ipcRenderer.send('contentZoom:adjust', 'out'),
  contentZoomReset: () => ipcRenderer.send('contentZoom:adjust', 'reset'),

  shareOpen: (payload: {
    docPath: string | null;
    markdown: string;
    displayTarget?: 'auto' | 'external' | 'primary';
  }) => ipcRenderer.send('share:open', payload),
  shareClose: () => ipcRenderer.send('share:close'),
  shareScrollTo: (payload: { progress: number }) => ipcRenderer.send('share:scrollTo', payload),

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
  onContentZoomUpdate: (cb: (payload: ContentZoomState) => void) => {
    const handler = (_: unknown, payload: ContentZoomState) => cb(payload);
    ipcRenderer.on('contentZoom:update', handler);
    return () => ipcRenderer.removeListener('contentZoom:update', handler);
  },

  onShareInit: (cb: (payload: ShareInit) => void) => {
    const handler = (_: unknown, payload: ShareInit) => cb(payload);
    ipcRenderer.on('share:init', handler);
    return () => ipcRenderer.removeListener('share:init', handler);
  },
  onShareScrollTo: (cb: (payload: { progress: number }) => void) => {
    const handler = (_: unknown, payload: { progress: number }) => cb(payload);
    ipcRenderer.on('share:scrollTo', handler);
    return () => ipcRenderer.removeListener('share:scrollTo', handler);
  },
  onShareClosed: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('share:closed', handler);
    return () => ipcRenderer.removeListener('share:closed', handler);
  }
});
