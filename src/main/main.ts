import { app, BrowserWindow, WebContentsView, ipcMain, protocol, screen, session, shell } from 'electron';
import type { Input, IpcMainInvokeEvent, Protocol, Rectangle } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

type NotesWindowSettings = {
  syncZoomWithEdit: boolean;
  syncDockWithEdit: boolean;
};

type PersistedState = {
  lastDocPath: string | null;
  lastWorkspaceDirPath: string | null;
  notesSettings: NotesWindowSettings;
  quickOpenUrl: string;
};

type ZoomAction = 'in' | 'out' | 'reset';
type ContentZoomState = {
  scale: number;
};

type FileBrowserEntry = {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  depth: number;
  parentPath: string | null;
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

type WebTabState = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
};

type WebTabRecord = {
  id: string;
  view: WebContentsView;
  state: WebTabState;
  bounds: Rectangle;
};

type WebTabResult = { success: true; tab: WebTabState } | { success: false; message: string };
type WebTabListResult = { success: true; tabs: WebTabState[] } | { success: false; message: string };


const EDIT_CONTENT_ZOOM_STEP = 0.1;
const EDIT_CONTENT_ZOOM_MIN = 0.7;
const EDIT_CONTENT_ZOOM_MAX = 2;
const DEFAULT_EDIT_CONTENT_ZOOM: ContentZoomState = { scale: 1 };
const MARKFLOW_ASSET_PROTOCOL = 'markflow-asset';
const WINDOW_DOCK_THRESHOLD = 28;
const MAC_WINDOW_DOCK_GAP = 4;
const WINDOWS_WINDOW_DOCK_GAP = -10;
const DEFAULT_WINDOW_DOCK_GAP = 4;
const DEFAULT_NOTES_SETTINGS: NotesWindowSettings = {
  syncZoomWithEdit: true,
  syncDockWithEdit: true
};
const DEFAULT_NOTES_WIDTH = 210;
const DEFAULT_NOTES_HEIGHT = 760;
const DEFAULT_QUICK_OPEN_URL = 'https://remix.ethereum.org/';
const WEB_TAB_PARTITION = 'persist:markflow-web-tabs';
const WEB_TAB_ZOOM_STEP = 0.1;
const WEB_TAB_ZOOM_MIN = 0.5;
const WEB_TAB_ZOOM_MAX = 3;
const DEFAULT_WEB_TAB_ZOOM_FACTOR = 1;

function chromeLikeUserAgent(): string {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
}

const WEB_TAB_USER_AGENT = chromeLikeUserAgent();

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
let currentWorkspaceDirPath: string | null = null;
let currentMarkdown = '';
let editContentZoom = DEFAULT_EDIT_CONTENT_ZOOM.scale;
let notesContentZoom = DEFAULT_EDIT_CONTENT_ZOOM.scale;
let notesSettings: NotesWindowSettings = { ...DEFAULT_NOTES_SETTINGS };
let quickOpenUrl = DEFAULT_QUICK_OPEN_URL;
let pendingOpenState: PendingOpenState = { filePath: null };
let currentNotesState: NotesWindowState | null = null;
let notesDockState: DockState | null = null;
let isApplyingDockBounds = false;
const webTabs = new Map<string, WebTabRecord>();
let activeWebTabId: string | null = null;

function stateFilePath(): string {
  return path.join(app.getPath('userData'), 'state.json');
}

function normalizeExternalHttpUrl(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeQuickOpenUrl(input: string | null | undefined): string {
  return normalizeExternalHttpUrl(input) ?? DEFAULT_QUICK_OPEN_URL;
}


function normalizeInternalWebUrl(input: string | null | undefined): string | null {
  const normalized = normalizeExternalHttpUrl(input);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isTrustedEditSender(event: IpcMainInvokeEvent): boolean {
  return Boolean(editWindow && !editWindow.isDestroyed() && event.sender.id === editWindow.webContents.id);
}

function cloneWebTabState(state: WebTabState): WebTabState {
  return { ...state };
}

function clampWebTabZoomFactor(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WEB_TAB_ZOOM_FACTOR;
  return Math.max(WEB_TAB_ZOOM_MIN, Math.min(WEB_TAB_ZOOM_MAX, Math.round(value * 100) / 100));
}

function webTabStates(): WebTabState[] {
  return [...webTabs.values()].map((tab) => cloneWebTabState(tab.state));
}

function sendWebTabUpdate(record: WebTabRecord) {
  editWindow?.webContents.send('webTab:updated', cloneWebTabState(record.state));
}

function sendWebTabsChanged() {
  editWindow?.webContents.send('webTab:listChanged', webTabStates());
}

function setWebTabState(record: WebTabRecord, patch: Partial<WebTabState>) {
  record.state = { ...record.state, ...patch };
  sendWebTabUpdate(record);
  sendWebTabsChanged();
}

function hideWebTab(record: WebTabRecord) {
  try {
    record.view.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
  } catch {
    // Native view may already be detached during teardown.
  }
}

function applyWebTabVisibility() {
  for (const record of webTabs.values()) {
    if (record.id === activeWebTabId) record.view.setBounds(record.bounds);
    else hideWebTab(record);
  }
}

function createWebTabView(id: string, initialUrl: string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Remix currently depends on browser APIs that can stall under Electron's strict sandboxed WebContentsView mode.
      // Keep Node disabled and context isolation/webSecurity enabled; do not expose a preload to remote pages.
      sandbox: false,
      webSecurity: true,
      backgroundThrottling: false,
      partition: WEB_TAB_PARTITION,
      transparent: false,
      spellcheck: false
    }
  });
  const contents = view.webContents;
  contents.userAgent = WEB_TAB_USER_AGENT;
  contents.on('before-input-event', (event, input) => {
    const action = getZoomAction(input);
    if (!action) return;
    event.preventDefault();
    adjustWebTabZoom(id, action);
  });
  contents.setWindowOpenHandler(({ url }) => {
    const normalized = normalizeInternalWebUrl(url);
    if (normalized) {
      void createOrFocusWebTab(normalized, true);
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const normalized = normalizeInternalWebUrl(url);
    if (!normalized) {
      event.preventDefault();
      return;
    }
  });
  contents.on('did-start-loading', () => {
    const record = webTabs.get(id);
    if (record) setWebTabState(record, { loading: true });
  });
  contents.on('did-stop-loading', () => {
    const record = webTabs.get(id);
    if (record) setWebTabState(record, { loading: false, canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward() });
  });
  contents.on('page-title-updated', (_event, title) => {
    const record = webTabs.get(id);
    if (record) setWebTabState(record, { title });
  });
  contents.on('did-navigate', (_event, url) => {
    const record = webTabs.get(id);
    if (record) setWebTabState(record, { url, title: contents.getTitle() || url, canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward() });
  });
  contents.on('did-navigate-in-page', (_event, url) => {
    const record = webTabs.get(id);
    if (record) setWebTabState(record, { url, title: contents.getTitle() || url, canGoBack: contents.canGoBack(), canGoForward: contents.canGoForward() });
  });
  contents.on('did-fail-load', (_event, _code, description, url) => {
    const record = webTabs.get(id);
    if (record) setWebTabState(record, { loading: false, url: url || record.state.url, title: description || record.state.title });
  });
  void contents.loadURL(initialUrl, { userAgent: WEB_TAB_USER_AGENT });
  return view;
}

async function createOrFocusWebTab(inputUrl: string, focus = true, reuseExisting = false): Promise<WebTabResult> {
  if (!editWindow || editWindow.isDestroyed()) return { success: false, message: 'Editor window is not available.' };
  const normalized = normalizeInternalWebUrl(inputUrl);
  if (!normalized) return { success: false, message: 'Only http/https URLs can be opened in MarkFlow tabs.' };

  const existing = reuseExisting ? [...webTabs.values()].find((tab) => tab.state.url === normalized) : null;
  if (existing) {
    if (focus) activeWebTabId = existing.id;
    applyWebTabVisibility();
    sendWebTabsChanged();
    return { success: true, tab: cloneWebTabState(existing.state) };
  }

  const id = crypto.randomUUID();
  const view = createWebTabView(id, normalized);
  const record: WebTabRecord = {
    id,
    view,
    bounds: { x: -10000, y: -10000, width: 1, height: 1 },
    state: {
      id,
      url: normalized,
      title: new URL(normalized).hostname || normalized,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: DEFAULT_WEB_TAB_ZOOM_FACTOR
    }
  };
  webTabs.set(id, record);
  view.webContents.zoomFactor = record.state.zoomFactor;
  editWindow.contentView.addChildView(view);
  if (focus) activeWebTabId = id;
  applyWebTabVisibility();
  sendWebTabsChanged();
  return { success: true, tab: cloneWebTabState(record.state) };
}

function closeWebTab(id: string): WebTabResult {
  const record = webTabs.get(id);
  if (!record) return { success: false, message: 'Web tab not found.' };
  try {
    editWindow?.contentView.removeChildView(record.view);
    record.view.webContents.close({ waitForBeforeUnload: false });
  } catch {
    // Closing a partially torn-down tab should not break app shutdown.
  }
  webTabs.delete(id);
  if (activeWebTabId === id) activeWebTabId = null;
  applyWebTabVisibility();
  sendWebTabsChanged();
  return { success: true, tab: cloneWebTabState(record.state) };
}

function focusWebTab(id: string | null): WebTabResult {
  if (id !== null && !webTabs.has(id)) return { success: false, message: 'Web tab not found.' };
  activeWebTabId = id;
  applyWebTabVisibility();
  sendWebTabsChanged();
  const tab = id ? webTabs.get(id) : null;
  return { success: true, tab: tab ? cloneWebTabState(tab.state) : { id: 'markdown', url: '', title: 'Markdown', loading: false, canGoBack: false, canGoForward: false, zoomFactor: DEFAULT_WEB_TAB_ZOOM_FACTOR } };
}

function navigateWebTab(id: string, inputUrl: string): WebTabResult {
  const record = webTabs.get(id);
  if (!record) return { success: false, message: 'Web tab not found.' };
  const normalized = normalizeInternalWebUrl(inputUrl);
  if (!normalized) return { success: false, message: 'Only http/https URLs can be opened in MarkFlow tabs.' };
  setWebTabState(record, { url: normalized, loading: true, title: new URL(normalized).hostname || normalized });
  void record.view.webContents.loadURL(normalized, { userAgent: WEB_TAB_USER_AGENT });
  return { success: true, tab: cloneWebTabState(record.state) };
}

function setWebTabBounds(id: string, bounds: Partial<Rectangle>): WebTabResult {
  const record = webTabs.get(id);
  if (!record) return { success: false, message: 'Web tab not found.' };
  const safeBounds: Rectangle = {
    x: Math.max(0, Math.round(Number(bounds.x) || 0)),
    y: Math.max(0, Math.round(Number(bounds.y) || 0)),
    width: Math.max(1, Math.round(Number(bounds.width) || 1)),
    height: Math.max(1, Math.round(Number(bounds.height) || 1))
  };
  record.bounds = safeBounds;
  if (activeWebTabId === id) record.view.setBounds(safeBounds);
  return { success: true, tab: cloneWebTabState(record.state) };
}

function setWebTabZoom(id: string, inputZoomFactor: number): WebTabResult {
  const record = webTabs.get(id);
  if (!record) return { success: false, message: 'Web tab not found.' };
  const zoomFactor = clampWebTabZoomFactor(inputZoomFactor);
  record.view.webContents.zoomFactor = zoomFactor;
  setWebTabState(record, { zoomFactor });
  return { success: true, tab: cloneWebTabState(record.state) };
}

function adjustWebTabZoom(id: string, action: ZoomAction): WebTabResult {
  const record = webTabs.get(id);
  if (!record) return { success: false, message: 'Web tab not found.' };
  const nextZoomFactor =
    action === 'reset'
      ? DEFAULT_WEB_TAB_ZOOM_FACTOR
      : record.state.zoomFactor + (action === 'in' ? WEB_TAB_ZOOM_STEP : -WEB_TAB_ZOOM_STEP);
  return setWebTabZoom(id, nextZoomFactor);
}

function destroyAllWebTabs() {
  for (const record of webTabs.values()) {
    try {
      editWindow?.contentView.removeChildView(record.view);
      record.view.webContents.close({ waitForBeforeUnload: false });
    } catch {
      // Ignore teardown races.
    }
  }
  webTabs.clear();
  activeWebTabId = null;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringField(input: unknown, field: string): string | null {
  if (!isRecord(input)) return null;
  const value = input[field];
  return typeof value === 'string' ? value : null;
}

function getNullableStringField(input: unknown, field: string): string | null {
  if (!isRecord(input)) return null;
  const value = input[field];
  return typeof value === 'string' ? value : null;
}


function sanitizedNotesSettings(input: Partial<NotesWindowSettings> | null | undefined): NotesWindowSettings {
  return {
    syncZoomWithEdit: typeof input?.syncZoomWithEdit === 'boolean' ? input.syncZoomWithEdit : DEFAULT_NOTES_SETTINGS.syncZoomWithEdit,
    syncDockWithEdit: typeof input?.syncDockWithEdit === 'boolean' ? input.syncDockWithEdit : DEFAULT_NOTES_SETTINGS.syncDockWithEdit
  };
}

async function readPersistedState(): Promise<PersistedState> {
  try {
    const raw = await fs.readFile(stateFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      lastDocPath: typeof parsed.lastDocPath === 'string' ? parsed.lastDocPath : null,
      lastWorkspaceDirPath: typeof parsed.lastWorkspaceDirPath === 'string' ? parsed.lastWorkspaceDirPath : null,
      notesSettings: sanitizedNotesSettings(parsed.notesSettings),
      quickOpenUrl: safeQuickOpenUrl(parsed.quickOpenUrl)
    };
  } catch {
    return {
      lastDocPath: null,
      lastWorkspaceDirPath: null,
      notesSettings: { ...DEFAULT_NOTES_SETTINGS },
      quickOpenUrl: DEFAULT_QUICK_OPEN_URL
    };
  }
}

async function writePersistedState(state: PersistedState): Promise<void> {
  await fs.mkdir(path.dirname(stateFilePath()), { recursive: true });
  await fs.writeFile(
    stateFilePath(),
    JSON.stringify({
      lastDocPath: state.lastDocPath,
      lastWorkspaceDirPath: state.lastWorkspaceDirPath,
      notesSettings: sanitizedNotesSettings(state.notesSettings),
      quickOpenUrl: safeQuickOpenUrl(state.quickOpenUrl)
    }),
    'utf-8'
  );
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
  await writeCurrentPersistedState({ lastDocPath: filePath });
  return { docPath: currentDocPath, markdown: currentMarkdown };
}

async function listDirectoryTree(dirPath: string, depth = 0, parentPath: string | null = null): Promise<FileBrowserEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const sortedEntries = entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  const result: FileBrowserEntry[] = [];
  for (const entry of sortedEntries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const children = await listDirectoryTree(entryPath, depth + 1, entryPath);
      if (children.length === 0) continue;
      result.push({
        name: entry.name,
        path: entryPath,
        kind: 'directory',
        depth,
        parentPath,
        isMarkdown: false
      });
      result.push(...children);
      continue;
    }

    if (!entry.isFile() || !looksLikeMarkdownPath(entryPath)) continue;
    result.push({
      name: entry.name,
      path: entryPath,
      kind: 'file',
      depth,
      parentPath,
      isMarkdown: true
    });
  }

  return result;
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

function shouldLoadDevServer(): boolean {
  return isDev() && Boolean(process.env.VITE_DEV_SERVER_URL);
}

function preloadPath(): string {
  return path.join(__dirname, '..', 'preload', 'preload.js');
}

function devServerUrl(): string {
  return process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
}

function getRendererUrl(view: 'edit' | 'notes' | 'print'): string {
  const q = `?view=${encodeURIComponent(view)}`;
  if (shouldLoadDevServer()) {
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

function currentWindowDockGap(): number {
  if (process.platform === 'win32') return WINDOWS_WINDOW_DOCK_GAP;
  if (process.platform === 'darwin') return MAC_WINDOW_DOCK_GAP;
  return DEFAULT_WINDOW_DOCK_GAP;
}

function currentEditContentZoomState(): ContentZoomState {
  return { scale: editContentZoom };
}

function notesContentZoomState(): ContentZoomState {
  return { scale: notesSettings.syncZoomWithEdit ? editContentZoom : notesContentZoom };
}

function notesSettingsState(): NotesWindowSettings {
  return { ...notesSettings };
}

function quickOpenState(): { url: string } {
  return { url: quickOpenUrl };
}

async function updateQuickOpenUrl(input: unknown): Promise<{ url: string }> {
  const normalized = normalizeExternalHttpUrl(getStringField(input, 'url'));
  if (!normalized) throw new Error('Quick-open URL must use http or https.');
  quickOpenUrl = normalized;
  await writeCurrentPersistedState();
  return quickOpenState();
}

async function writeCurrentPersistedState(
  input: Partial<Pick<PersistedState, 'lastDocPath' | 'lastWorkspaceDirPath'>> = {}
): Promise<void> {
  await writePersistedState({
    lastDocPath: input.lastDocPath ?? currentDocPath,
    lastWorkspaceDirPath: input.lastWorkspaceDirPath ?? currentWorkspaceDirPath,
    notesSettings,
    quickOpenUrl
  });
}

async function setCurrentWorkspaceDirPath(dirPath: string | null): Promise<string | null> {
  currentWorkspaceDirPath = dirPath ? path.resolve(dirPath) : null;
  await writeCurrentPersistedState();
  return currentWorkspaceDirPath;
}

async function updateNotesSettings(input: Partial<NotesWindowSettings> | null | undefined): Promise<NotesWindowSettings> {
  const nextSettings = sanitizedNotesSettings({ ...notesSettings, ...input });
  const prevSettings = notesSettings;

  if (prevSettings.syncZoomWithEdit && !nextSettings.syncZoomWithEdit) {
    notesContentZoom = editContentZoom;
  }

  notesSettings = nextSettings;

  if (!nextSettings.syncDockWithEdit) {
    notesDockState = null;
  } else if (!prevSettings.syncDockWithEdit) {
    refreshNotesDockState();
  }

  await writeCurrentPersistedState();
  broadcastContentZoom();
  return notesSettingsState();
}

function broadcastContentZoom() {
  const nextNotesZoom = notesContentZoomState().scale;
  if (currentNotesState) {
    currentNotesState = {
      ...currentNotesState,
      zoomScale: nextNotesZoom
    };
  }
  editWindow?.webContents.send('contentZoom:update', currentEditContentZoomState());
  notesWindow?.webContents.send('contentZoom:update', { scale: nextNotesZoom });
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

function adjustNotesContentZoom(action: ZoomAction) {
  if (notesSettings.syncZoomWithEdit) {
    adjustEditContentZoom(action);
    return;
  }

  if (action === 'reset') {
    notesContentZoom = DEFAULT_EDIT_CONTENT_ZOOM.scale;
  } else {
    const delta = action === 'in' ? EDIT_CONTENT_ZOOM_STEP : -EDIT_CONTENT_ZOOM_STEP;
    notesContentZoom = clampEditContentZoom(notesContentZoom + delta);
  }
  if (notesWindow) setWindowPageZoom(notesWindow);
  broadcastContentZoom();
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

function registerZoomShortcuts(window: BrowserWindow, target: 'edit' | 'notes') {
  window.webContents.on('before-input-event', (event, input) => {
    const action = getZoomAction(input);
    if (!action) return;
    event.preventDefault();
    if (target === 'edit') {
      adjustEditContentZoom(action);
      return;
    }
    adjustNotesContentZoom(action);
  });
}

function rangesNearOrOverlap(startA: number, endA: number, startB: number, endB: number, slack: number): boolean {
  return endA >= startB - slack && endB >= startA - slack;
}

function getDockCandidate(companionBounds: Rectangle, anchorBounds: Rectangle): DockCandidate | null {
  const candidates: DockCandidate[] = [];
  const gap = currentWindowDockGap();

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
  window.setPosition(bounds.x, bounds.y);
  setImmediate(() => {
    isApplyingDockBounds = false;
  });
}

function syncDockedNotesWindow() {
  if (!notesSettings.syncDockWithEdit) return;
  if (!editWindow || !notesWindow || !notesDockState) return;
  if (notesWindow.isDestroyed() || notesWindow.isMinimized() || notesWindow.isMaximized() || notesWindow.isFullScreen()) {
    return;
  }
  const nextBounds = getDockedCompanionBounds(editWindow.getBounds(), notesWindow.getBounds(), notesDockState);
  applyDockedBounds(notesWindow, nextBounds);
}

function refreshNotesDockState() {
  if (!notesSettings.syncDockWithEdit) {
    notesDockState = null;
    return;
  }
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
  const gap = currentWindowDockGap();
  const width = clampNumber(Math.round(editBounds.width * 0.33), 260, Math.max(260, workArea.width - 40));
  const height = clampNumber(Math.round(editBounds.height * 0.92), 520, Math.max(520, workArea.height - 40));
  const alignedY = clampNumber(editBounds.y, workArea.y + 20, workArea.y + workArea.height - height - 20);
  const rightX = editBounds.x + editBounds.width + gap;
  const leftX = editBounds.x - width - gap;
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
      gap
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
  registerZoomShortcuts(editWindow, 'edit');
  setWindowPageZoom(editWindow);
  editWindow.webContents.on('did-finish-load', () => {
    setWindowPageZoom(editWindow!);
    broadcastContentZoom();
    void openPendingDocumentIfAny();
  });
  editWindow.webContents.setWindowOpenHandler(({ url }) => {
    const normalized = normalizeExternalHttpUrl(url);
    if (normalized) void shell.openExternal(normalized);
    return { action: 'deny' };
  });
  editWindow.webContents.on('will-navigate', (event, url) => {
    if (url === editWindow?.webContents.getURL() || url.startsWith(getRendererUrl('edit'))) return;
    event.preventDefault();
    const normalized = normalizeExternalHttpUrl(url);
    if (normalized) void shell.openExternal(normalized);
  });
  editWindow.loadURL(getRendererUrl('edit'));
  editWindow.setMenuBarVisibility(false);
  const syncNotes = () => {
    syncDockedNotesWindow();
  };
  editWindow.on('move', syncNotes);
  editWindow.on('resize', () => {
    syncNotes();
    applyWebTabVisibility();
  });
  editWindow.on('closed', () => {
    notesWindow?.close();
    notesWindow = null;
    notesDockState = null;
    destroyAllWebTabs();
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
    if (!notesWindow.isVisible()) {
      notesWindow.showInactive();
    }
    editWindow?.focus();
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

  registerZoomShortcuts(notesWindow, 'notes');
  setWindowPageZoom(notesWindow);
  notesDockState = notesSettings.syncDockWithEdit ? placement.dockState : null;
  notesWindow.webContents.setWindowOpenHandler(({ url }) => {
    const normalized = normalizeExternalHttpUrl(url);
    if (normalized) void shell.openExternal(normalized);
    return { action: 'deny' };
  });
  notesWindow.webContents.on('will-navigate', (event, url) => {
    if (url === notesWindow?.webContents.getURL() || url.startsWith(getRendererUrl('notes'))) return;
    event.preventDefault();
    const normalized = normalizeExternalHttpUrl(url);
    if (normalized) void shell.openExternal(normalized);
  });
  notesWindow.loadURL(getRendererUrl('notes'));
  notesWindow.setMenuBarVisibility(false);

  const pushInitial = () => {
    setWindowPageZoom(notesWindow!);
    notesWindow?.webContents.send('contentZoom:update', notesContentZoomState());
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
    notesWindow?.showInactive();
    editWindow?.focus();
  });
  notesWindow.on('move', refreshNotesDockState);
  notesWindow.on('resize', refreshNotesDockState);
  notesWindow.on('closed', () => {
    notesWindow = null;
    notesDockState = null;
    notifyNotesClosed();
  });
}


function toMarkdownAssetUrl(filePath: string): string {
  return `${MARKFLOW_ASSET_PROTOCOL}://asset?path=${encodeURIComponent(path.normalize(filePath))}`;
}

function isHttpLikeUrl(value: string): boolean {
  return /^(?:https?:|data:|blob:|markflow-asset:)/i.test(value);
}

function stripMarkdownImageDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1).trim();
  return trimmed;
}

async function resolveMarkdownImageUrlForRenderer(input: unknown): Promise<{ success: true; url: string } | { success: false; message: string; url?: string }> {
  const rawUrl = stripMarkdownImageDestination(getStringField(input, 'url') ?? '');
  const docPath = getNullableStringField(input, 'docPath');
  if (!rawUrl) return { success: false, message: 'Image URL is empty.' };
  if (rawUrl.startsWith('#') || rawUrl.startsWith('//') || isHttpLikeUrl(rawUrl)) return { success: true, url: rawUrl };

  let filePath: string;
  try {
    if (/^file:/i.test(rawUrl)) {
      filePath = fileURLToPath(rawUrl);
    } else if (path.isAbsolute(rawUrl)) {
      filePath = rawUrl;
    } else if (docPath) {
      filePath = path.resolve(path.dirname(docPath), rawUrl);
    } else {
      return { success: false, message: 'Relative image paths require a saved Markdown file.' };
    }

    await fs.access(filePath);
    return { success: true, url: toMarkdownAssetUrl(filePath) };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Image file could not be resolved.',
      url: typeof filePath! === 'string' ? toMarkdownAssetUrl(filePath!) : undefined
    };
  }
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

async function handleMarkdownAssetRequest(request: Request): Promise<Response> {
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
}

function registerMarkdownAssetProtocol(targetProtocol: Protocol = protocol) {
  targetProtocol.handle(MARKFLOW_ASSET_PROTOCOL, handleMarkdownAssetRequest);
}

function configureWebTabSession() {
  const webSession = session.fromPartition(WEB_TAB_PARTITION);
  webSession.setUserAgent(WEB_TAB_USER_AGENT);
  webSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'fullscreen' || permission === 'pointerLock' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
  });
  webSession.setPermissionCheckHandler((_webContents, permission) => (
    permission === 'fullscreen' ||
    permission === 'pointerLock' ||
    permission === 'clipboard-read' ||
    permission === 'clipboard-sanitized-write'
  ));
}

function waitForPrintRender(window: BrowserWindow, payload: { markdown: string; docPath: string | null }): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while rendering PDF content.'));
    }, 10000);

    const cleanup = () => {
      clearTimeout(timeout);
      ipcMain.removeListener('print:rendered', onRendered);
    };

    const onRendered = (event: Electron.IpcMainEvent, result: unknown) => {
      if (event.sender !== window.webContents) return;
      cleanup();
      if (isRecord(result) && result.success === true) {
        resolve();
        return;
      }
      reject(new Error(getStringField(result, 'message') ?? 'Unable to render PDF content.'));
    };

    ipcMain.on('print:rendered', onRendered);
    window.webContents.send('print:render', payload);
  });
}

async function renderMarkdownPdf(markdown: string, docPath: string | null): Promise<Buffer> {
  const partition = `pdf-export-${crypto.randomUUID()}`;
  const pdfSession = session.fromPartition(partition);
  registerMarkdownAssetProtocol(pdfSession.protocol);

  let pdfWindow: BrowserWindow | null = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath(),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  try {
    const rendererUrl = getRendererUrl('print');
    pdfWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    pdfWindow.webContents.on('will-navigate', (event, url) => {
      if (url === pdfWindow?.webContents.getURL() || url.startsWith(rendererUrl)) return;
      event.preventDefault();
    });
    await pdfWindow.loadURL(rendererUrl);
    await waitForPrintRender(pdfWindow, { markdown, docPath });
    return await pdfWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally {
    pdfWindow?.close();
    pdfSession.protocol.unhandle(MARKFLOW_ASSET_PROTOCOL);
    pdfWindow = null;
  }
}

app.whenReady().then(async () => {
  registerMarkdownAssetProtocol();
  configureWebTabSession();
  setPendingOpenPath(extractMarkdownPathFromArgv(process.argv.slice(1)));
  createEditWindow();

  if (pendingOpenState.filePath) {
    return;
  }

  const persisted = await readPersistedState();
  currentWorkspaceDirPath = persisted.lastWorkspaceDirPath ? path.resolve(persisted.lastWorkspaceDirPath) : null;
  notesSettings = persisted.notesSettings;
  quickOpenUrl = safeQuickOpenUrl(persisted.quickOpenUrl);
  if (notesSettings.syncZoomWithEdit) {
    notesContentZoom = editContentZoom;
  }
  if (persisted.lastDocPath) {
    try {
      const restored = await loadDocument(persisted.lastDocPath);
      editWindow?.webContents.once('did-finish-load', () => {
        editWindow?.webContents.send('doc:update', restored);
      });
    } catch {
      await writeCurrentPersistedState({ lastDocPath: null });
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
    await writeCurrentPersistedState({ lastDocPath: filePath });
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
    const dirPath = path.resolve(res.filePaths[0]!);
    await setCurrentWorkspaceDirPath(dirPath);
    return { dirPath };
  });

  ipcMain.handle('folder:list', async (_evt, args: { dirPath: string }) => {
    const dirPath = path.resolve(args.dirPath);
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error('Selected path is not a directory.');
    }
    return {
      dirPath,
      entries: await listDirectoryTree(dirPath)
    };
  });

  ipcMain.handle('workspace:state:get', async () => {
    return { dirPath: currentWorkspaceDirPath };
  });

  ipcMain.handle('workspace:state:set', async (_evt, args: { dirPath: string | null }) => {
    if (!args.dirPath) {
      await setCurrentWorkspaceDirPath(null);
      return { dirPath: currentWorkspaceDirPath };
    }

    const dirPath = path.resolve(args.dirPath);
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error('Selected path is not a directory.');
    }

    await setCurrentWorkspaceDirPath(dirPath);
    return { dirPath: currentWorkspaceDirPath };
  });


  ipcMain.handle('quickOpen:get', async () => quickOpenState());

  ipcMain.handle('quickOpen:set', async (_evt, args: unknown) => updateQuickOpenUrl(args));

  ipcMain.handle('asset:resolveImageUrl', async (_evt, args: unknown) => resolveMarkdownImageUrlForRenderer(args));

  ipcMain.handle('webTab:list', async (event): Promise<WebTabListResult> => {
    if (!isTrustedEditSender(event)) return { success: false, message: 'Unauthorized web tab request.' };
    return { success: true, tabs: webTabStates() };
  });

  ipcMain.handle('webTab:create', async (event, args: unknown): Promise<WebTabResult> => {
    if (!isTrustedEditSender(event)) return { success: false, message: 'Unauthorized web tab request.' };
    return createOrFocusWebTab(getStringField(args, 'url') ?? '', true, isRecord(args) && args.reuseExisting === true);
  });

  ipcMain.handle('webTab:focus', async (event, args: unknown): Promise<WebTabResult> => {
    if (!isTrustedEditSender(event)) return { success: false, message: 'Unauthorized web tab request.' };
    return focusWebTab(getNullableStringField(args, 'id'));
  });

  ipcMain.handle('webTab:close', async (event, args: unknown): Promise<WebTabResult> => {
    if (!isTrustedEditSender(event)) return { success: false, message: 'Unauthorized web tab request.' };
    return closeWebTab(getStringField(args, 'id') ?? '');
  });

  ipcMain.handle('webTab:navigate', async (event, args: unknown): Promise<WebTabResult> => {
    if (!isTrustedEditSender(event)) return { success: false, message: 'Unauthorized web tab request.' };
    return navigateWebTab(getStringField(args, 'id') ?? '', getStringField(args, 'url') ?? '');
  });

  ipcMain.handle('webTab:setBounds', async (event, args: unknown): Promise<WebTabResult> => {
    if (!isTrustedEditSender(event)) return { success: false, message: 'Unauthorized web tab request.' };
    if (!isRecord(args)) return { success: false, message: 'Invalid bounds.' };
    return setWebTabBounds(getStringField(args, 'id') ?? '', args);
  });

  ipcMain.handle('webTab:setZoom', async (event, args: unknown): Promise<WebTabResult> => {
    if (!isTrustedEditSender(event)) return { success: false, message: 'Unauthorized web tab request.' };
    if (!isRecord(args)) return { success: false, message: 'Invalid zoom.' };
    return setWebTabZoom(getStringField(args, 'id') ?? '', Number(args.zoomFactor));
  });

  ipcMain.handle('webTab:adjustZoom', async (event, args: unknown): Promise<WebTabResult> => {
    if (!isTrustedEditSender(event)) return { success: false, message: 'Unauthorized web tab request.' };
    const action = getStringField(args, 'action');
    if (action !== 'in' && action !== 'out' && action !== 'reset') return { success: false, message: 'Invalid zoom action.' };
    return adjustWebTabZoom(getStringField(args, 'id') ?? '', action);
  });

  ipcMain.handle('export:pdf', async (_evt, args: unknown) => {
    const { dialog } = await import('electron');
    if (!editWindow) return { success: false as const, message: 'Editor window is not available.' };
    const markdown = getStringField(args, 'markdown');
    if (markdown == null) {
      return { success: false as const, message: 'PDF export requires markdown.' };
    }
    const docPath = getNullableStringField(args, 'docPath');
    const defaultBase = docPath ? path.basename(docPath, path.extname(docPath)) : 'markflow-document';
    const res = await dialog.showSaveDialog(editWindow, {
      defaultPath: `${defaultBase}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return { success: false as const, canceled: true as const };

    try {
      const pdf = await renderMarkdownPdf(markdown, docPath);
      await fs.writeFile(res.filePath, pdf);
      return { success: true as const, filePath: res.filePath };
    } catch (error) {
      return { success: false as const, message: error instanceof Error ? error.message : 'PDF export failed.' };
    }
  });

  ipcMain.on('doc:setMarkdown', (_evt, args: { markdown: string; docPath: string | null }) => {
    currentMarkdown = args.markdown;
    currentDocPath = args.docPath;
  });

  ipcMain.on('contentZoom:adjust', (_evt, action: ZoomAction) => {
    adjustEditContentZoom(action);
  });

  ipcMain.handle('notes:settings:get', async () => {
    return notesSettingsState();
  });

  ipcMain.handle('notes:settings:set', async (_evt, input: Partial<NotesWindowSettings> | null | undefined) => {
    return updateNotesSettings(input);
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
    const nextState: NotesWindowState = {
      ...payload,
      zoomScale: notesContentZoomState().scale
    };
    currentNotesState = nextState;
    forwardToNotes('notes:update', nextState);
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

type AppInfo = {
  version: string;
  author: string;
  repositoryUrl: string;
};

const APP_INFO_BASE = {
  author: 'zhouCode',
  repositoryUrl: 'https://github.com/zhouCode/MarkFlow'
} as const;

async function resolveAppVersion(): Promise<string> {
  const packageJsonCandidates = Array.from(
    new Set([path.join(app.getAppPath(), 'package.json'), path.resolve(__dirname, '../../package.json')])
  );

  for (const packageJsonPath of packageJsonCandidates) {
    try {
      const raw = await fs.readFile(packageJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version;
    } catch {
      continue;
    }
  }

  return app.getVersion();
}

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

ipcMain.handle('app:info', async (): Promise<AppInfo> => ({
  ...APP_INFO_BASE,
  version: await resolveAppVersion()
}));

ipcMain.handle('app:openExternal', async (_evt, args: unknown) => {
  const normalized = normalizeExternalHttpUrl(getStringField(args, 'url'));
  if (!normalized) return { success: false, message: 'Only http/https URLs can be opened externally.' };
  await shell.openExternal(normalized);
  return { success: true };
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
