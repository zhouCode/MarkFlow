import { app, BrowserWindow, ipcMain, screen } from 'electron';
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

let editWindow: BrowserWindow | null = null;
let shareWindow: BrowserWindow | null = null;

let currentDocPath: string | null = null;
let currentMarkdown = '';
let currentShareProgress = 0;

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

function createEditWindow() {
  editWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'MarkFlow',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
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
      nodeIntegration: false
    }
  });

  shareWindow.loadURL(getRendererUrl('share'));
  shareWindow.setMenuBarVisibility(false);

  const pushInitial = () => {
    shareWindow?.webContents.send('share:init', {
      docPath: payload.docPath,
      markdown: payload.markdown,
      progress: currentShareProgress
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
