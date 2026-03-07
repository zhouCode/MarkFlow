import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { Input } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

type ShareOpenPayload = {
  docPath: string | null;
  markdown: string;
  displayTarget?: 'auto' | 'external' | 'primary';
};

type PersistedState = {
  lastDocPath: string | null;
};

type ZoomAction = 'in' | 'out' | 'reset';
type ContentZoomState = {
  scale: number;
};

const EDIT_CONTENT_ZOOM_STEP = 0.1;
const EDIT_CONTENT_ZOOM_MIN = 0.7;
const EDIT_CONTENT_ZOOM_MAX = 2;
const DEFAULT_EDIT_CONTENT_ZOOM: ContentZoomState = { scale: 1 };

let editWindow: BrowserWindow | null = null;
let shareWindow: BrowserWindow | null = null;

let currentDocPath: string | null = null;
let currentMarkdown = '';
let currentShareProgress = 0;
let editContentZoom = DEFAULT_EDIT_CONTENT_ZOOM.scale;

function stateFilePath(): string {
  return path.join(app.getPath('userData'), 'state.json');
}

async function readPersistedState(): Promise<PersistedState> {
  try {
    const raw = await fs.readFile(stateFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return { lastDocPath: typeof parsed.lastDocPath === 'string' ? parsed.lastDocPath : null };
  } catch {
    return { lastDocPath: null };
  }
}

async function writePersistedState(state: PersistedState): Promise<void> {
  await fs.mkdir(path.dirname(stateFilePath()), { recursive: true });
  await fs.writeFile(stateFilePath(), JSON.stringify(state), 'utf-8');
}

async function loadDocument(filePath: string) {
  const markdown = await fs.readFile(filePath, 'utf-8');
  currentDocPath = filePath;
  currentMarkdown = markdown;
  await writePersistedState({ lastDocPath: filePath });
  return { docPath: currentDocPath, markdown: currentMarkdown };
}

function isDev(): boolean {
  return !app.isPackaged;
}

function preloadPath(): string {
  return path.join(__dirname, '..', 'preload', 'preload.js');
}

function devServerUrl(): string {
  return process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
}

function getRendererUrl(view: 'edit' | 'share'): string {
  const q = `?view=${encodeURIComponent(view)}`;
  if (isDev()) {
    return `${devServerUrl()}/${q}`;
  }
  const indexPath = path.join(__dirname, '..', 'renderer', 'index.html');
  const base = pathToFileURL(indexPath).toString();
  return `${base}${q}`;
}

function clampEditContentZoom(scale: number): number {
  return Math.max(EDIT_CONTENT_ZOOM_MIN, Math.min(EDIT_CONTENT_ZOOM_MAX, Number(scale.toFixed(2))));
}

function currentEditContentZoomState(): ContentZoomState {
  return { scale: editContentZoom };
}

function broadcastContentZoom() {
  const state = currentEditContentZoomState();
  editWindow?.webContents.send('contentZoom:update', state);
  shareWindow?.webContents.send('contentZoom:update', state);
}

function setWindowPageZoom(window: BrowserWindow) {
  window.webContents.setZoomLevel(0);
}

function adjustEditContentZoom(action: ZoomAction) {
  if (action === 'reset') {
    editContentZoom = DEFAULT_EDIT_CONTENT_ZOOM.scale;
  } else {
    const delta = action === 'in' ? EDIT_CONTENT_ZOOM_STEP : -EDIT_CONTENT_ZOOM_STEP;
    editContentZoom = clampEditContentZoom(editContentZoom + delta);
  }
  if (editWindow) setWindowPageZoom(editWindow);
  if (shareWindow) setWindowPageZoom(shareWindow);
  broadcastContentZoom();
}

function adjustWindowZoom(window: BrowserWindow, action: ZoomAction) {
  const { webContents } = window;
  if (action === 'reset') {
    webContents.setZoomLevel(0);
    return;
  }
  const delta = action === 'in' ? 1 : -1;
  webContents.setZoomLevel(webContents.getZoomLevel() + delta);
}

function getZoomAction(input: Input): ZoomAction | null {
  if (!(input.control || input.meta) || input.type !== 'keyDown') return null;

  switch (input.code) {
    case 'Minus':
    case 'NumpadSubtract':
      return 'out';
    case 'Equal':
    case 'NumpadAdd':
      return 'in';
    case 'Digit0':
    case 'Numpad0':
      return 'reset';
    default:
      break;
  }

  switch (input.key) {
    case '-':
      return 'out';
    case '=':
    case '+':
      return 'in';
    case '0':
      return 'reset';
    default:
      return null;
  }
}

function registerZoomShortcuts(window: BrowserWindow, options?: { useContentZoom?: boolean }) {
  window.webContents.on('before-input-event', (event, input) => {
    const action = getZoomAction(input);
    if (!action) return;
    event.preventDefault();
    if (options?.useContentZoom) {
      adjustEditContentZoom(action);
      return;
    }
    adjustWindowZoom(window, action);
  });
}

function createEditWindow() {
  editWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'MarkFlow',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  registerZoomShortcuts(editWindow, { useContentZoom: true });
  setWindowPageZoom(editWindow);
  editWindow.webContents.on('did-finish-load', () => {
    setWindowPageZoom(editWindow!);
    broadcastContentZoom();
  });
  editWindow.loadURL(getRendererUrl('edit'));
  editWindow.setMenuBarVisibility(false);
  editWindow.on('closed', () => {
    editWindow = null;
  });
}

function chooseShareDisplay(target: 'auto' | 'external' | 'primary' = 'auto') {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (target === 'primary') return primary;
  if (target === 'external') {
    return displays.find((d) => d.id !== primary.id) ?? primary;
  }
  return displays.find((d) => d.id !== primary.id) ?? primary;
}

function forwardToShare(channel: string, payload: unknown) {
  shareWindow?.webContents.send(channel, payload);
}

function notifyShareClosed() {
  editWindow?.webContents.send('share:closed');
}

function createShareWindow(payload: ShareOpenPayload) {
  const shareDisplay = chooseShareDisplay(payload.displayTarget ?? 'auto');

  shareWindow?.close();

  shareWindow = new BrowserWindow({
    x: shareDisplay.bounds.x + 40,
    y: shareDisplay.bounds.y + 40,
    width: Math.min(1280, Math.max(900, shareDisplay.workAreaSize.width - 80)),
    height: Math.min(820, Math.max(640, shareDisplay.workAreaSize.height - 80)),
    title: 'MarkFlow Share Window',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  registerZoomShortcuts(shareWindow, { useContentZoom: true });
  setWindowPageZoom(shareWindow);
  shareWindow.loadURL(getRendererUrl('share'));
  shareWindow.setMenuBarVisibility(false);

  const pushInitial = () => {
    setWindowPageZoom(shareWindow!);
    shareWindow?.webContents.send('share:init', {
      docPath: payload.docPath,
      markdown: payload.markdown,
      progress: currentShareProgress,
      zoomScale: editContentZoom
    });
  };

  shareWindow.webContents.once('did-finish-load', pushInitial);
  shareWindow.once('ready-to-show', () => {
    pushInitial();
    setTimeout(pushInitial, 50);
    shareWindow?.show();
    shareWindow?.focus();
  });
  shareWindow.on('closed', () => {
    shareWindow = null;
    notifyShareClosed();
  });
}

app.whenReady().then(async () => {
  createEditWindow();

  const persisted = await readPersistedState();
  if (persisted.lastDocPath) {
    try {
      const restored = await loadDocument(persisted.lastDocPath);
      editWindow?.webContents.once('did-finish-load', () => {
        editWindow?.webContents.send('doc:update', restored);
      });
    } catch {
      await writePersistedState({ lastDocPath: null });
    }
  }

  ipcMain.handle('doc:open', async () => {
    const { dialog } = await import('electron');
    if (!editWindow) return null;
    const res = await dialog.showOpenDialog(editWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }]
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const filePath = res.filePaths[0]!;
    const payload = await loadDocument(filePath);
    editWindow.webContents.send('doc:update', payload);
    forwardToShare('doc:update', payload);
    return payload;
  });

  ipcMain.handle('doc:save', async (_evt, args: { docPath: string | null; markdown: string }) => {
    const { dialog } = await import('electron');
    if (!editWindow) return null;
    let filePath = args.docPath ?? null;
    if (!filePath) {
      const res = await dialog.showSaveDialog(editWindow, {
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      });
      if (res.canceled || !res.filePath) return null;
      filePath = res.filePath;
    }
    await fs.writeFile(filePath, args.markdown, 'utf-8');
    currentDocPath = filePath;
    currentMarkdown = args.markdown;
    await writePersistedState({ lastDocPath: filePath });
    editWindow.webContents.send('doc:saved', { docPath: currentDocPath });
    return { docPath: currentDocPath };
  });

  ipcMain.on('doc:setMarkdown', (_evt, args: { markdown: string; docPath: string | null }) => {
    currentMarkdown = args.markdown;
    currentDocPath = args.docPath;
    forwardToShare('doc:update', { docPath: currentDocPath, markdown: currentMarkdown });
  });

  ipcMain.on('contentZoom:adjust', (_evt, action: ZoomAction) => {
    adjustEditContentZoom(action);
  });

  ipcMain.on('share:open', (_evt, payload: ShareOpenPayload) => {
    createShareWindow(payload);
  });

  ipcMain.on('share:close', () => {
    shareWindow?.close();
    shareWindow = null;
    editWindow?.focus();
  });

  ipcMain.on('share:scrollTo', (_evt, payload: unknown) => {
    const progress = typeof (payload as { progress?: unknown })?.progress === 'number'
      ? Number((payload as { progress: number }).progress)
      : 0;
    currentShareProgress = Math.max(0, Math.min(1, progress));
    forwardToShare('share:scrollTo', { progress: currentShareProgress });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createEditWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
