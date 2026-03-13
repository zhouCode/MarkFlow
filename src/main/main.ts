import { app, BrowserWindow, ipcMain, protocol, screen } from 'electron';
import type { Input, Rectangle } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  setPendingOpenPath(filePath);
  void openPendingDocumentIfAny();
});

app.on('second-instance', (_event, argv) => {
  setPendingOpenPath(extractMarkdownPathFromArgv(argv));
  if (editWindow) {
    if (editWindow.isMinimized()) editWindow.restore();
    editWindow.focus();
  }
  void openPendingDocumentIfAny();
});

type NotesWindowState = {
  mode: 'preview' | 'edit';
  activeAnchor: string | null;
  groups: Array<{
    anchorId: string;
    top: number;
    notes: Array<{
      id: string;
      line: number;
      html: string;
    }>;
  }>;
  scrollHeight: number;
  scrollTop: number;
  zoomScale: number;
};

type PersistedState = {
  lastDocPath: string | null;
};

type ZoomAction = 'in' | 'out' | 'reset';
type ContentZoomState = {
  scale: number;
};

type FileBrowserEntry = {
  name: string;
  path: string;
  isMarkdown: boolean;
};

type PendingOpenState = {
  filePath: string | null;
};

type DockEdge = 'left' | 'right' | 'top' | 'bottom';

type DockState = {
  edge: DockEdge;
  offset: number;
  gap: number;
};

type DockCandidate = DockState & {
  distance: number;
};

type CompanionPlacement = {
  bounds: Rectangle;
  dockState: DockState | null;
};

const EDIT_CONTENT_ZOOM_STEP = 0.1;
const EDIT_CONTENT_ZOOM_MIN = 0.7;
const EDIT_CONTENT_ZOOM_MAX = 2;
const DEFAULT_EDIT_CONTENT_ZOOM: ContentZoomState = { scale: 1 };
const MARKFLOW_ASSET_PROTOCOL = 'markflow-asset';
const WINDOW_DOCK_THRESHOLD = 28;
const WINDOW_DOCK_GAP = 4;
const DEFAULT_NOTES_WIDTH = 210;
const DEFAULT_NOTES_HEIGHT = 760;

protocol.registerSchemesAsPrivileged([
  {
    scheme: MARKFLOW_ASSET_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
]);

let editWindow: BrowserWindow | null = null;
let notesWindow: BrowserWindow | null = null;

let currentDocPath: string | null = null;
let currentMarkdown = '';
let editContentZoom = DEFAULT_EDIT_CONTENT_ZOOM.scale;
let pendingOpenState: PendingOpenState = { filePath: null };
let currentNotesState: NotesWindowState | null = null;
let notesDockState: DockState | null = null;
let isApplyingDockBounds = false;

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

function looksLikeMarkdownPath(filePath: string | null | undefined): filePath is string {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.md' || ext === '.markdown' || ext === '.mdx';
}

function extractMarkdownPathFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (looksLikeMarkdownPath(arg)) return arg;
  }
  return null;
}

function setPendingOpenPath(filePath: string | null | undefined) {
  if (!looksLikeMarkdownPath(filePath)) return;
  pendingOpenState.filePath = filePath;
}

function clearPendingOpenPath(filePath: string | null) {
  if (pendingOpenState.filePath === filePath) pendingOpenState.filePath = null;
}

async function loadDocument(filePath: string) {
  const markdown = await fs.readFile(filePath, 'utf-8');
  currentDocPath = filePath;
  currentMarkdown = markdown;
  await writePersistedState({ lastDocPath: filePath });
  return { docPath: currentDocPath, markdown: currentMarkdown };
}

async function listDirectoryFiles(dirPath: string): Promise<FileBrowserEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(dirPath, entry.name);
      return {
        name: entry.name,
        path: filePath,
        isMarkdown: looksLikeMarkdownPath(filePath)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

async function loadDocumentIntoWindows(filePath: string) {
  const payload = await loadDocument(filePath);
  editWindow?.webContents.send('doc:update', payload);
  forwardToNotes('doc:update', payload);
  clearPendingOpenPath(filePath);
  return payload;
}

function isRendererReady(window: BrowserWindow | null): boolean {
  return Boolean(window && !window.webContents.isLoadingMainFrame());
}

async function openPendingDocumentIfAny() {
  const filePath = pendingOpenState.filePath;
  if (!filePath || !isRendererReady(editWindow)) return false;

  try {
    await loadDocumentIntoWindows(filePath);
    return true;
  } catch {
    clearPendingOpenPath(filePath);
    return false;
  }
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

function getRendererUrl(view: 'edit' | 'notes'): string {
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

function clampNumber(value: number, min: number, max: number): number {
  if (min > max) return value;
  return Math.max(min, Math.min(max, value));
}

function currentEditContentZoomState(): ContentZoomState {
  return { scale: editContentZoom };
}

function broadcastContentZoom() {
  const state = currentEditContentZoomState();
  editWindow?.webContents.send('contentZoom:update', state);
  notesWindow?.webContents.send('contentZoom:update', state);
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
  if (notesWindow) setWindowPageZoom(notesWindow);
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

function rangesNearOrOverlap(startA: number, endA: number, startB: number, endB: number, slack: number): boolean {
  return endA >= startB - slack && endB >= startA - slack;
}

function getDockCandidate(companionBounds: Rectangle, anchorBounds: Rectangle): DockCandidate | null {
  const candidates: DockCandidate[] = [];
  const gap = WINDOW_DOCK_GAP;

  if (
    rangesNearOrOverlap(
      companionBounds.y,
      companionBounds.y + companionBounds.height,
      anchorBounds.y,
      anchorBounds.y + anchorBounds.height,
      WINDOW_DOCK_THRESHOLD
    )
  ) {
    const rightDistance = Math.abs(companionBounds.x - (anchorBounds.x + anchorBounds.width + gap));
    if (rightDistance <= WINDOW_DOCK_THRESHOLD) {
      candidates.push({
        edge: 'right',
        offset: companionBounds.y - anchorBounds.y,
        gap,
        distance: rightDistance
      });
    }

    const leftDistance = Math.abs((companionBounds.x + companionBounds.width + gap) - anchorBounds.x);
    if (leftDistance <= WINDOW_DOCK_THRESHOLD) {
      candidates.push({
        edge: 'left',
        offset: companionBounds.y - anchorBounds.y,
        gap,
        distance: leftDistance
      });
    }
  }

  if (
    rangesNearOrOverlap(
      companionBounds.x,
      companionBounds.x + companionBounds.width,
      anchorBounds.x,
      anchorBounds.x + anchorBounds.width,
      WINDOW_DOCK_THRESHOLD
    )
  ) {
    const bottomDistance = Math.abs(companionBounds.y - (anchorBounds.y + anchorBounds.height + gap));
    if (bottomDistance <= WINDOW_DOCK_THRESHOLD) {
      candidates.push({
        edge: 'bottom',
        offset: companionBounds.x - anchorBounds.x,
        gap,
        distance: bottomDistance
      });
    }

    const topDistance = Math.abs((companionBounds.y + companionBounds.height + gap) - anchorBounds.y);
    if (topDistance <= WINDOW_DOCK_THRESHOLD) {
      candidates.push({
        edge: 'top',
        offset: companionBounds.x - anchorBounds.x,
        gap,
        distance: topDistance
      });
    }
  }

  return candidates.sort((a, b) => a.distance - b.distance)[0] ?? null;
}

function getDockedCompanionBounds(anchorBounds: Rectangle, companionBounds: Rectangle, dockState: DockState): Rectangle {
  switch (dockState.edge) {
    case 'left':
      return {
        x: anchorBounds.x - companionBounds.width - dockState.gap,
        y: anchorBounds.y + dockState.offset,
        width: companionBounds.width,
        height: companionBounds.height
      };
    case 'right':
      return {
        x: anchorBounds.x + anchorBounds.width + dockState.gap,
        y: anchorBounds.y + dockState.offset,
        width: companionBounds.width,
        height: companionBounds.height
      };
    case 'top':
      return {
        x: anchorBounds.x + dockState.offset,
        y: anchorBounds.y - companionBounds.height - dockState.gap,
        width: companionBounds.width,
        height: companionBounds.height
      };
    case 'bottom':
      return {
        x: anchorBounds.x + dockState.offset,
        y: anchorBounds.y + anchorBounds.height + dockState.gap,
        width: companionBounds.width,
        height: companionBounds.height
      };
    default:
      return companionBounds;
  }
}

function applyDockedBounds(window: BrowserWindow, bounds: Rectangle) {
  isApplyingDockBounds = true;
  window.setBounds(bounds);
  setImmediate(() => {
    isApplyingDockBounds = false;
  });
}

function syncDockedNotesWindow() {
  if (!editWindow || !notesWindow || !notesDockState) return;
  if (notesWindow.isDestroyed() || notesWindow.isMinimized() || notesWindow.isMaximized() || notesWindow.isFullScreen()) {
    return;
  }
  const nextBounds = getDockedCompanionBounds(editWindow.getBounds(), notesWindow.getBounds(), notesDockState);
  applyDockedBounds(notesWindow, nextBounds);
}

function refreshNotesDockState() {
  if (!editWindow || !notesWindow) return;
  if (isApplyingDockBounds || notesWindow.isMinimized() || notesWindow.isMaximized() || notesWindow.isFullScreen()) return;

  const candidate = getDockCandidate(notesWindow.getBounds(), editWindow.getBounds());
  if (!candidate) {
    notesDockState = null;
    return;
  }

  notesDockState = {
    edge: candidate.edge,
    offset: candidate.offset,
    gap: candidate.gap
  };
  syncDockedNotesWindow();
}

function notesPlacementNearEditWindow(): CompanionPlacement | null {
  if (!editWindow) return null;

  const editBounds = editWindow.getBounds();
  const display = screen.getDisplayMatching(editBounds);
  const workArea = display.workArea;
  const width = clampNumber(Math.round(editBounds.width * 0.33), 260, Math.max(260, workArea.width - 40));
  const height = clampNumber(Math.round(editBounds.height * 0.92), 520, Math.max(520, workArea.height - 40));
  const alignedY = clampNumber(editBounds.y, workArea.y + 20, workArea.y + workArea.height - height - 20);
  const rightX = editBounds.x + editBounds.width + WINDOW_DOCK_GAP;
  const leftX = editBounds.x - width - WINDOW_DOCK_GAP;
  const canDockRight = rightX + width <= workArea.x + workArea.width - 12;
  const canDockLeft = leftX >= workArea.x + 12;
  const edge: DockEdge = canDockRight || !canDockLeft ? 'right' : 'left';
  const x = edge === 'right' ? rightX : leftX;

  return {
    bounds: {
      x,
      y: alignedY,
      width,
      height
    },
    dockState: {
      edge,
      offset: alignedY - editBounds.y,
      gap: WINDOW_DOCK_GAP
    }
  };
}

function defaultNotesPlacement(): CompanionPlacement {
  const companionPlacement = notesPlacementNearEditWindow();
  if (companionPlacement) return companionPlacement;

  const noteDisplay = editWindow ? screen.getDisplayMatching(editWindow.getBounds()) : screen.getPrimaryDisplay();
  const width = Math.min(DEFAULT_NOTES_WIDTH, Math.max(360, noteDisplay.workAreaSize.width - 80));
  const height = Math.min(DEFAULT_NOTES_HEIGHT, Math.max(560, noteDisplay.workAreaSize.height - 80));

  return {
    bounds: {
      x: noteDisplay.bounds.x + Math.max(32, Math.round((noteDisplay.workAreaSize.width - width) / 2)),
      y: noteDisplay.bounds.y + Math.max(32, Math.round((noteDisplay.workAreaSize.height - height) / 2)),
      width,
      height
    },
    dockState: null
  };
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
    void openPendingDocumentIfAny();
  });
  editWindow.loadURL(getRendererUrl('edit'));
  editWindow.setMenuBarVisibility(false);
  const syncNotes = () => {
    syncDockedNotesWindow();
  };
  editWindow.on('move', syncNotes);
  editWindow.on('resize', syncNotes);
  editWindow.on('closed', () => {
    notesWindow?.close();
    notesWindow = null;
    notesDockState = null;
    editWindow = null;
  });
}

function forwardToNotes(channel: string, payload: unknown) {
  notesWindow?.webContents.send(channel, payload);
}

function notifyNotesClosed() {
  editWindow?.webContents.send('notes:closed');
}

function createNotesWindow() {
  if (notesWindow && !notesWindow.isDestroyed()) {
    if (notesWindow.isMinimized()) notesWindow.restore();
    notesWindow.focus();
    return;
  }

  const placement = defaultNotesPlacement();

  notesWindow = new BrowserWindow({
    ...placement.bounds,
    title: 'MarkFlow Notes',
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  registerZoomShortcuts(notesWindow, { useContentZoom: true });
  setWindowPageZoom(notesWindow);
  notesDockState = placement.dockState;
  notesWindow.loadURL(getRendererUrl('notes'));
  notesWindow.setMenuBarVisibility(false);

  const pushInitial = () => {
    setWindowPageZoom(notesWindow!);
    if (currentNotesState) {
      notesWindow?.webContents.send('notes:update', currentNotesState);
    }
  };

  notesWindow.webContents.once('did-finish-load', pushInitial);
  notesWindow.once('ready-to-show', () => {
    pushInitial();
    if (notesDockState) {
      syncDockedNotesWindow();
    }
    notesWindow?.show();
    notesWindow?.focus();
  });
  notesWindow.on('move', refreshNotesDockState);
  notesWindow.on('resize', refreshNotesDockState);
  notesWindow.on('closed', () => {
    notesWindow = null;
    notesDockState = null;
    notifyNotesClosed();
  });
}

function contentTypeForAsset(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.bmp':
      return 'image/bmp';
    case '.ico':
      return 'image/x-icon';
    case '.avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

function createAssetResponse(bytes: Buffer, filePath: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': contentTypeForAsset(filePath),
      'Cache-Control': 'no-cache'
    }
  });
}

function registerMarkdownAssetProtocol() {
  protocol.handle(MARKFLOW_ASSET_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      const assetPath = url.searchParams.get('path');
      if (!assetPath) {
        return new Response('Not found', { status: 404 });
      }
      const bytes = await fs.readFile(assetPath);
      return createAssetResponse(bytes, assetPath);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

app.whenReady().then(async () => {
  registerMarkdownAssetProtocol();
  setPendingOpenPath(extractMarkdownPathFromArgv(process.argv.slice(1)));
  createEditWindow();

  if (pendingOpenState.filePath) {
    return;
  }

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
    return loadDocumentIntoWindows(filePath);
  });

  ipcMain.handle('doc:openPath', async (_evt, args: { filePath: string }) => {
    if (!looksLikeMarkdownPath(args.filePath)) {
      throw new Error('Only Markdown files can be opened in the editor.');
    }
    return loadDocumentIntoWindows(args.filePath);
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

  ipcMain.handle('folder:open', async () => {
    const { dialog } = await import('electron');
    if (!editWindow) return null;
    const res = await dialog.showOpenDialog(editWindow, {
      properties: ['openDirectory']
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return { dirPath: res.filePaths[0]! };
  });

  ipcMain.handle('folder:list', async (_evt, args: { dirPath: string }) => {
    const dirPath = path.resolve(args.dirPath);
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error('Selected path is not a directory.');
    }
    return {
      dirPath,
      entries: await listDirectoryFiles(dirPath)
    };
  });

  ipcMain.on('doc:setMarkdown', (_evt, args: { markdown: string; docPath: string | null }) => {
    currentMarkdown = args.markdown;
    currentDocPath = args.docPath;
  });

  ipcMain.on('contentZoom:adjust', (_evt, action: ZoomAction) => {
    adjustEditContentZoom(action);
  });

  ipcMain.on('notes:open', () => {
    createNotesWindow();
  });

  ipcMain.on('notes:close', () => {
    notesWindow?.close();
    notesWindow = null;
    editWindow?.focus();
  });

  ipcMain.on('notes:update', (_evt, payload: NotesWindowState) => {
    currentNotesState = payload;
    forwardToNotes('notes:update', payload);
  });

  ipcMain.on('notes:navigateTo', (_evt, payload: { anchorId: string }) => {
    editWindow?.webContents.send('notes:navigateTo', payload);
    editWindow?.focus();
  });

  ipcMain.on('notes:scrollTo', (_evt, payload: { progress: number }) => {
    editWindow?.webContents.send('notes:scrollTo', payload);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createEditWindow();
  });
});

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

type UpdateCheckResult =
  | { status: 'available'; version: string }
  | { status: 'not-available' }
  | { status: 'error'; message: string };

type UpdateDownloadProgress = {
  percent: number;
  transferred: number;
  total: number;
};

ipcMain.handle('update:check', async (): Promise<UpdateCheckResult> => {
  if (isDev()) {
    return { status: 'error', message: 'Update check is not available in development mode' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo.version !== app.getVersion()) {
      return { status: 'available', version: result.updateInfo.version };
    }
    return { status: 'not-available' };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'Unknown error' };
  }
});

ipcMain.handle('update:download', async () => {
  if (isDev()) {
    return { success: false, message: 'Update download is not available in development mode' };
  }
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : 'Unknown error' };
  }
});

ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

autoUpdater.on('download-progress', (progress) => {
  const payload: UpdateDownloadProgress = {
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total
  };
  editWindow?.webContents.send('update:download-progress', payload);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
