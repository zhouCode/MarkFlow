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

  interface Window {
    markflow: {
      platform: string;
      docOpen: () => Promise<{ docPath: string | null; markdown: string } | null>;
      docOpenPath: (args: { filePath: string }) => Promise<{ docPath: string | null; markdown: string }>;
      docSave: (args: { docPath: string | null; markdown: string }) => Promise<{ docPath: string | null } | null>;
      docSetMarkdown: (args: { docPath: string | null; markdown: string }) => void;
      folderOpen: () => Promise<{ dirPath: string } | null>;
      folderList: (args: { dirPath: string }) => Promise<{ dirPath: string; entries: FileBrowserEntry[] }>;

      contentZoomIn: () => void;
      contentZoomOut: () => void;
      contentZoomReset: () => void;

      notesOpen: () => void;
      notesClose: () => void;
      notesUpdate: (payload: NotesWindowState) => void;
      notesNavigateTo: (payload: { anchorId: string }) => void;
      notesScrollTo: (payload: { progress: number }) => void;

      onDocUpdate: (cb: (payload: { docPath: string | null; markdown: string }) => void) => () => void;
      onDocSaved: (cb: (payload: { docPath: string | null }) => void) => () => void;
      onContentZoomUpdate: (cb: (payload: { scale: number }) => void) => () => void;

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
      openExternal: (args: { url: string }) => Promise<{ success: boolean }>;
    };
  }
}
