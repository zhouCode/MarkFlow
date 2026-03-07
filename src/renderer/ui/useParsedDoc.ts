import React from 'react';
import { ParsedDoc, renderMarkdown } from '../markdown/parse';

export function useParsedDoc(markdown: string, options?: { debounceMs?: number }) {
  const [parsed, setParsed] = React.useState<ParsedDoc | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const debounceMs = options?.debounceMs ?? 120;

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
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [markdown, debounceMs]);

  return { parsed, error };
}

