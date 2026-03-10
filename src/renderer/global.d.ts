export {};

declare global {
  interface Window {
    markflow: {
      docOpen: () => Promise<{ docPath: string | null; markdown: string } | null>;
      docSave: (args: { docPath: string | null; markdown: string }) => Promise<{ docPath: string | null } | null>;
      docSetMarkdown: (args: { docPath: string | null; markdown: string }) => void;

      contentZoomIn: () => void;
      contentZoomOut: () => void;
      contentZoomReset: () => void;

      shareOpen: (payload: {
        docPath: string | null;
        markdown: string;
        displayTarget?: 'auto' | 'external' | 'primary';
      }) => void;
      shareClose: () => void;
      shareScrollTo: (payload: { progress: number }) => void;

      onDocUpdate: (cb: (payload: { docPath: string | null; markdown: string }) => void) => () => void;
      onDocSaved: (cb: (payload: { docPath: string | null }) => void) => () => void;
      onContentZoomUpdate: (cb: (payload: { scale: number }) => void) => () => void;

      onShareInit: (cb: (payload: { docPath: string | null; markdown: string; progress: number; zoomScale: number }) => void) => () => void;
      onShareScrollTo: (cb: (payload: { progress: number }) => void) => () => void;
      onShareClosed: (cb: () => void) => () => void;

      updateCheck: () => Promise<
        | { status: 'available'; version: string }
        | { status: 'not-available' }
        | { status: 'error'; message: string }
      >;
      updateDownload: () => Promise<{ success: boolean; message?: string }>;
      updateInstall: () => void;
      onUpdateDownloadProgress: (cb: (payload: { percent: number; transferred: number; total: number }) => void) => () => void;
    };
  }
}
