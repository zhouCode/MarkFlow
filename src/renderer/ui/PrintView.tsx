import React from 'react';
import { renderMarkdown } from '../markdown/parse';

type PrintState = {
  html: string;
  error: string | null;
};

export function PrintView() {
  const [state, setState] = React.useState<PrintState>({ html: '', error: null });

  React.useEffect(() => {
    return window.markflow.onPrintRender((payload) => {
      void (async () => {
        try {
          const parsed = await renderMarkdown(payload.markdown, { docPath: payload.docPath });
          setState({ html: parsed.html, error: null });
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              window.markflow.printRendered({ success: true });
            });
          });
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
      <article className="markdown printContent" dangerouslySetInnerHTML={{ __html: state.html }} />
    </main>
  );
}
