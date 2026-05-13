import React from 'react';
import { renderMarkdown } from '../markdown/parse';

type PrintState = {
  html: string;
  error: string | null;
};

async function waitForPrintAssets(root: HTMLElement): Promise<void> {
  const fontReady = 'fonts' in document ? document.fonts.ready.catch(() => undefined) : Promise.resolve();
  const imageReady = Array.from(root.querySelectorAll('img')).map(async (image) => {
    if (image.complete && image.naturalWidth > 0) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
    });
    if ('decode' in image) await image.decode().catch(() => undefined);
  });
  await Promise.all([fontReady, ...imageReady]);
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export function PrintView() {
  const [state, setState] = React.useState<PrintState>({ html: '', error: null });
  const contentRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    return window.markflow.onPrintRender((payload) => {
      void (async () => {
        try {
          const parsed = await renderMarkdown(payload.markdown, { docPath: payload.docPath });
          setState({ html: parsed.html, error: null });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (contentRef.current) await waitForPrintAssets(contentRef.current);
          window.markflow.printRendered({ success: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to render PDF content.';
          setState({ html: '', error: message });
          window.markflow.printRendered({ success: false, message });
        }
      })();
    });
  }, []);

  return (
    <main className="printShell">
      {state.error ? <div className="printError">{state.error}</div> : null}
      <article ref={contentRef} className="markdown printContent" dangerouslySetInnerHTML={{ __html: state.html }} />
    </main>
  );
}
