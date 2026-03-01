import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

type PresentMode = 'present-scroll' | 'present-slides';
type Aspect = '4:3' | '16:9';

type PresentOpenPayload = {
  docPath: string | null;
  markdown: string;
  initialMode: PresentMode;
  aspect: Aspect;
  displayTarget?: 'auto' | 'external' | 'primary';
};

let editWindow: BrowserWindow | null = null;
let presenterWindow: BrowserWindow | null = null;
let audienceWindow: BrowserWindow | null = null;

let currentDocPath: string | null = null;
let currentMarkdown = '';

function isDev(): boolean {
  return !app.isPackaged;
}

function preloadPath(): string {
  // Runtime layout (dev): dist/main/main.js, dist/preload/preload.js, dist/renderer/index.html
  return path.join(__dirname, '..', 'preload', 'preload.js');
}

function devServerUrl(): string {
  return process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
}

function getRendererUrl(view: 'edit' | 'presenter' | 'audience'): string {
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

function chooseAudienceDisplay(target: 'auto' | 'external' | 'primary' = 'auto') {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (target === 'primary') return primary;
  if (target === 'external') {
    return displays.find((d) => d.id !== primary.id) ?? primary;
  }
  // auto: prefer non-primary if present
  return displays.find((d) => d.id !== primary.id) ?? primary;
}

function createPresentationWindows(payload: PresentOpenPayload) {
  const audienceDisplay = chooseAudienceDisplay(payload.displayTarget ?? 'auto');
  const presenterDisplay = screen.getPrimaryDisplay();

  audienceWindow?.close();
  presenterWindow?.close();

  audienceWindow = new BrowserWindow({
    x: audienceDisplay.bounds.x,
    y: audienceDisplay.bounds.y,
    width: Math.min(1280, audienceDisplay.workAreaSize.width),
    height: Math.min(720, audienceDisplay.workAreaSize.height),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  presenterWindow = new BrowserWindow({
    x: presenterDisplay.bounds.x + 40,
    y: presenterDisplay.bounds.y + 40,
    width: 1400,
    height: 900,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  audienceWindow.loadURL(getRendererUrl('audience'));
  presenterWindow.loadURL(getRendererUrl('presenter'));
  audienceWindow.setMenuBarVisibility(false);
  presenterWindow.setMenuBarVisibility(false);
  // Default to fullscreen for the audience output (common projector workflow).
  audienceWindow.once('ready-to-show', () => {
    try {
      audienceWindow?.setFullScreen(true);
    } catch {
      // ignore
    }
  });

  // Once loaded, push initial state into both windows.
  const pushInitial = () => {
    const msg = {
      docPath: payload.docPath,
      markdown: payload.markdown,
      initialMode: payload.initialMode,
      aspect: payload.aspect
    };
    presenterWindow?.webContents.send('present:init', msg);
    audienceWindow?.webContents.send('present:init', msg);
  };

  presenterWindow.webContents.on('did-finish-load', pushInitial);
  audienceWindow.webContents.on('did-finish-load', pushInitial);

  audienceWindow.on('closed', () => {
    audienceWindow = null;
  });
  presenterWindow.on('closed', () => {
    presenterWindow = null;
  });
}

function forwardToAudience(channel: string, payload: unknown) {
  audienceWindow?.webContents.send(channel, payload);
}

function forwardToPresenter(channel: string, payload: unknown) {
  presenterWindow?.webContents.send(channel, payload);
}

app.whenReady().then(() => {
  createEditWindow();

  ipcMain.handle('doc:open', async () => {
    const { dialog } = await import('electron');
    if (!editWindow) return null;
    const res = await dialog.showOpenDialog(editWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }]
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const filePath = res.filePaths[0]!;
    const markdown = await fs.readFile(filePath, 'utf-8');
    currentDocPath = filePath;
    currentMarkdown = markdown;
    // Push to any open windows.
    editWindow.webContents.send('doc:update', { docPath: currentDocPath, markdown: currentMarkdown });
    forwardToPresenter('doc:update', { docPath: currentDocPath, markdown: currentMarkdown });
    forwardToAudience('doc:update', { docPath: currentDocPath, markdown: currentMarkdown });
    return { docPath: currentDocPath, markdown: currentMarkdown };
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
    editWindow.webContents.send('doc:saved', { docPath: currentDocPath });
    forwardToPresenter('doc:saved', { docPath: currentDocPath });
    forwardToAudience('doc:saved', { docPath: currentDocPath });
    return { docPath: currentDocPath };
  });

  ipcMain.on('doc:setMarkdown', (_evt, args: { markdown: string; docPath: string | null }) => {
    currentMarkdown = args.markdown;
    currentDocPath = args.docPath;
    forwardToPresenter('doc:update', { docPath: currentDocPath, markdown: currentMarkdown });
    forwardToAudience('doc:update', { docPath: currentDocPath, markdown: currentMarkdown });
  });

  ipcMain.on('present:open', (_evt, payload: PresentOpenPayload) => {
    createPresentationWindows(payload);
  });

  ipcMain.on('present:close', () => {
    try {
      audienceWindow?.setFullScreen(false);
    } catch {
      // ignore
    }
    audienceWindow?.close();
    presenterWindow?.close();
    audienceWindow = null;
    presenterWindow = null;
    editWindow?.focus();
  });

  ipcMain.on('present:setMode', (_evt, payload: { mode: PresentMode }) => {
    forwardToAudience('present:setMode', payload);
  });
  ipcMain.on('present:setAspect', (_evt, payload: { aspect: Aspect }) => {
    forwardToAudience('present:setAspect', payload);
  });
  ipcMain.on('present:scrollTo', (_evt, payload: unknown) => {
    forwardToAudience('present:scrollTo', payload);
  });
  ipcMain.on('present:setSlide', (_evt, payload: { index: number }) => {
    forwardToAudience('present:setSlide', payload);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createEditWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
