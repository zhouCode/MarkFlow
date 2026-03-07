export {};

declare global {
  interface Window {
    markflow: {
      docOpen: () => Promise<{ docPath: string | null; markdown: string } | null>;
      docSave: (args: { docPath: string | null; markdown: string }) => Promise<{ docPath: string | null } | null>;
      docSetMarkdown: (args: { docPath: string | null; markdown: string }) => void;

      presentOpen: (payload: {
        docPath: string | null;
        markdown: string;
        initialMode: 'present-scroll' | 'present-slides';
        aspect: '4:3' | '16:9';
        displayTarget?: 'auto' | 'external' | 'primary';
      }) => void;
      presentClose: () => void;

      presentSetMode: (payload: { mode: 'present-scroll' | 'present-slides' }) => void;
      presentSetAspect: (payload: { aspect: '4:3' | '16:9' }) => void;
      presentScrollTo: (payload: any) => void;
      presentSetSlide: (payload: { index: number }) => void;
      presentSetSlideScroll: (payload: { progress: number }) => void;

      onDocUpdate: (cb: (payload: { docPath: string | null; markdown: string }) => void) => () => void;
      onDocSaved: (cb: (payload: { docPath: string | null }) => void) => () => void;

      onPresentInit: (
        cb: (payload: {
          docPath: string | null;
          markdown: string;
          initialMode: 'present-scroll' | 'present-slides';
          aspect: '4:3' | '16:9';
        }) => void
      ) => () => void;
      onPresentSetMode: (cb: (payload: { mode: 'present-scroll' | 'present-slides' }) => void) => () => void;
      onPresentSetAspect: (cb: (payload: { aspect: '4:3' | '16:9' }) => void) => () => void;
      onPresentScrollTo: (cb: (payload: any) => void) => () => void;
      onPresentSetSlide: (cb: (payload: { index: number }) => void) => () => void;
      onPresentSetSlideScroll: (cb: (payload: { progress: number }) => void) => () => void;
    };
  }
}
