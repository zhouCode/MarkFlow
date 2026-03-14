import { contextBridge, ipcRenderer } from 'electron';

export type ContentZoomState = {
  scale: number;
};

export type NotesWindowSettings = {
  syncZoomWithEdit: boolean;
  syncDockWithEdit: boolean;
};

export type FileBrowserEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  depth: number;
  parentPath: string | null;
  isMarkdown: boolean;
};

export type NotesWindowEntry = {
  id: string;
  line: number;
  html: string;
};

export type NotesWindowGroup = {
  anchorId: string;
  top: number;
  notes: NotesWindowEntry[];
};

export type NotesWindowState = {
  mode: 'preview' | 'edit';
  activeAnchor: string | null;
  groups: NotesWindowGroup[];
  scrollHeight: number;
  scrollTop: number;
  zoomScale: number;
};

export type UpdateCheckResult =
  | { status: 'available'; version: string }
  | { status: 'not-available' }
  | { status: 'error'; message: string };

export type UpdateDownloadProgress = {
  percent: number;
  transferred: number;
  total: number;
};

export type AppInfo = {
  version: string;
  author: string;
  repositoryUrl: string;
};

contextBridge.exposeInMainWorld('markflow', {
  platform: process.platform,
  docOpen: () => ipcRenderer.invoke('doc:open'),
  docOpenPath: (args: { filePath: string }) => ipcRenderer.invoke('doc:openPath', args),
  docSave: (args: { docPath: string | null; markdown: string }) => ipcRenderer.invoke('doc:save', args),
  docSetMarkdown: (args: { docPath: string | null; markdown: string }) => ipcRenderer.send('doc:setMarkdown', args),
  folderOpen: () => ipcRenderer.invoke('folder:open'),
  folderList: (args: { dirPath: string }) => ipcRenderer.invoke('folder:list', args),
  workspaceStateGet: () => ipcRenderer.invoke('workspace:state:get'),

  contentZoomIn: () => ipcRenderer.send('contentZoom:adjust', 'in'),
  contentZoomOut: () => ipcRenderer.send('contentZoom:adjust', 'out'),
  contentZoomReset: () => ipcRenderer.send('contentZoom:adjust', 'reset'),

  notesSettingsGet: () => ipcRenderer.invoke('notes:settings:get'),
  notesSettingsSet: (input: Partial<NotesWindowSettings>) => ipcRenderer.invoke('notes:settings:set', input),
  notesOpen: () => ipcRenderer.send('notes:open'),
  notesClose: () => ipcRenderer.send('notes:close'),
  notesUpdate: (payload: NotesWindowState) => ipcRenderer.send('notes:update', payload),

  notesNavigateTo: (payload: { anchorId: string }) => ipcRenderer.send('notes:navigateTo', payload),
  notesScrollTo: (payload: { progress: number }) => ipcRenderer.send('notes:scrollTo', payload),

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

  onNotesUpdate: (cb: (payload: NotesWindowState) => void) => {
    const handler = (_: unknown, payload: NotesWindowState) => cb(payload);
    ipcRenderer.on('notes:update', handler);
    return () => ipcRenderer.removeListener('notes:update', handler);
  },
  onNotesClosed: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('notes:closed', handler);
    return () => ipcRenderer.removeListener('notes:closed', handler);
  },
  onNotesNavigateTo: (cb: (payload: { anchorId: string }) => void) => {
    const handler = (_: unknown, payload: { anchorId: string }) => cb(payload);
    ipcRenderer.on('notes:navigateTo', handler);
    return () => ipcRenderer.removeListener('notes:navigateTo', handler);
  },
  onNotesScrollTo: (cb: (payload: { progress: number }) => void) => {
    const handler = (_: unknown, payload: { progress: number }) => cb(payload);
    ipcRenderer.on('notes:scrollTo', handler);
    return () => ipcRenderer.removeListener('notes:scrollTo', handler);
  },

  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onUpdateDownloadProgress: (cb: (payload: UpdateDownloadProgress) => void) => {
    const handler = (_: unknown, payload: UpdateDownloadProgress) => cb(payload);
    ipcRenderer.on('update:download-progress', handler);
    return () => ipcRenderer.removeListener('update:download-progress', handler);
  },

  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (args: { url: string }) => ipcRenderer.invoke('app:openExternal', args)
});
