export {};

declare global {
  type NotesWindowEntry = {
    id: string;
    line: number;
    html: string;
  };

  type NotesWindowGroup = {
    anchorId: string;
    top: number;
    notes: NotesWindowEntry[];
  };

  type NotesWindowState = {
    mode: 'preview' | 'edit';
    activeAnchor: string | null;
    groups: NotesWindowGroup[];
    scrollHeight: number;
    scrollTop: number;
    zoomScale: number;
  };

  type ContentZoomState = {
    scale: number;
  };

  type NotesWindowSettings = {
    syncZoomWithEdit: boolean;
    syncDockWithEdit: boolean;
  };

  type FileBrowserEntry = {
    name: string;
    path: string;
    kind: 'directory' | 'file';
    depth: number;
    parentPath: string | null;
    isMarkdown: boolean;
  };

  type AppInfo = {
    version: string;
    author: string;
    repositoryUrl: string;
  };

  type OpenExternalResult = { success: true } | { success: false; message: string };
  type PdfExportResult =
    | { success: true; filePath: string }
    | { success: false; canceled?: boolean; message?: string };
  type QuickOpenState = { url: string };
  type ImageResolveResult = { success: true; url: string } | { success: false; message: string; url?: string };
  type PrintRenderPayload = { markdown: string; docPath: string | null };
  type PrintRenderedResult = { success: true } | { success: false; message: string };
  type WebTabState = { id: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; zoomFactor: number };
  type WebTabResult = { success: true; tab: WebTabState } | { success: false; message: string };
  type WebTabListResult = { success: true; tabs: WebTabState[] } | { success: false; message: string };

  interface Window {
    markflow: {
      platform: string;
      docOpen: () => Promise<{ docPath: string | null; markdown: string } | null>;
      docOpenPath: (args: { filePath: string }) => Promise<{ docPath: string | null; markdown: string }>;
      docSave: (args: { docPath: string | null; markdown: string }) => Promise<{ docPath: string | null } | null>;
      docSetMarkdown: (args: { docPath: string | null; markdown: string }) => void;
      folderOpen: () => Promise<{ dirPath: string } | null>;
      folderList: (args: { dirPath: string }) => Promise<{ dirPath: string; entries: FileBrowserEntry[] }>;
      workspaceStateGet: () => Promise<{ dirPath: string | null }>;
      workspaceStateSet: (args: { dirPath: string | null }) => Promise<{ dirPath: string | null }>;
      quickOpenGet: () => Promise<QuickOpenState>;
      quickOpenSet: (args: { url: string }) => Promise<QuickOpenState>;
      resolveImageUrl: (args: { url: string; docPath: string | null }) => Promise<ImageResolveResult>;

      contentZoomIn: () => void;
      contentZoomOut: () => void;
      contentZoomReset: () => void;

      notesSettingsGet: () => Promise<NotesWindowSettings>;
      notesSettingsSet: (input: Partial<NotesWindowSettings>) => Promise<NotesWindowSettings>;
      notesOpen: () => void;
      notesClose: () => void;
      notesUpdate: (payload: NotesWindowState) => void;
      notesNavigateTo: (payload: { anchorId: string }) => void;
      notesScrollTo: (payload: { progress: number }) => void;

      onDocUpdate: (cb: (payload: { docPath: string | null; markdown: string }) => void) => () => void;
      onDocSaved: (cb: (payload: { docPath: string | null }) => void) => () => void;
      onContentZoomUpdate: (cb: (payload: ContentZoomState) => void) => () => void;

      onNotesUpdate: (cb: (payload: NotesWindowState) => void) => () => void;
      onNotesClosed: (cb: () => void) => () => void;
      onNotesNavigateTo: (cb: (payload: { anchorId: string }) => void) => () => void;
      onNotesScrollTo: (cb: (payload: { progress: number }) => void) => () => void;

      updateCheck: () => Promise<
        | { status: 'available'; version: string }
        | { status: 'not-available' }
        | { status: 'error'; message: string }
      >;
      updateDownload: () => Promise<{ success: boolean; message?: string }>;
      updateInstall: () => void;
      onUpdateDownloadProgress: (cb: (payload: { percent: number; transferred: number; total: number }) => void) => () => void;
      appInfo: () => Promise<AppInfo>;
      openExternal: (args: { url: string }) => Promise<OpenExternalResult>;
      webTabList: () => Promise<WebTabListResult>;
      webTabCreate: (args: { url: string; reuseExisting?: boolean }) => Promise<WebTabResult>;
      webTabFocus: (args: { id: string | null }) => Promise<WebTabResult>;
      webTabClose: (args: { id: string }) => Promise<WebTabResult>;
      webTabNavigate: (args: { id: string; url: string }) => Promise<WebTabResult>;
      webTabSetBounds: (args: { id: string; x: number; y: number; width: number; height: number }) => Promise<WebTabResult>;
      webTabSetZoom: (args: { id: string; zoomFactor: number }) => Promise<WebTabResult>;
      webTabAdjustZoom: (args: { id: string; action: 'in' | 'out' | 'reset' }) => Promise<WebTabResult>;
      onWebTabUpdated: (cb: (payload: WebTabState) => void) => () => void;
      onWebTabListChanged: (cb: (payload: WebTabState[]) => void) => () => void;
      exportPdf: (args: { markdown: string; docPath: string | null }) => Promise<PdfExportResult>;
      onPrintRender: (cb: (payload: PrintRenderPayload) => void) => () => void;
      printRendered: (payload: PrintRenderedResult) => void;
    };
  }
}
