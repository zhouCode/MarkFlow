import React from 'react';
import { ParsedDoc, renderMarkdown } from '../markdown/parse';

export function useParsedDoc(markdown: string) {
  const [parsed, setParsed] = React.useState<ParsedDoc | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      renderMarkdown(markdown)
        .then((p) => {
          if (cancelled) return;
          setParsed(p);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(String(e?.message ?? e));
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [markdown]);

  return { parsed, error };
}

