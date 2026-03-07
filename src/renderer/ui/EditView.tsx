import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { useParsedDoc } from './useParsedDoc';
import { renderInlineMarkdown } from '../markdown/parse';
import { useTheme } from './theme';

export function EditView() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [docPath, setDocPath] = React.useState<string | null>(null);
  const [markdown, setMarkdown] = React.useState<string>('');
  const [lastSavedMarkdown, setLastSavedMarkdown] = React.useState<string>('');
  const { parsed } = useParsedDoc(markdown);
  const [leftMode, setLeftMode] = React.useState<'preview' | 'edit'>('preview');
  const [shareWindowOpen, setShareWindowOpen] = React.useState(false);
  const [noteHtmlById, setNoteHtmlById] = React.useState<Record<string, string>>({});
  const previewScrollRef = React.useRef<HTMLDivElement | null>(null);
  const previewRef = React.useRef<HTMLDivElement | null>(null);
  const notesScrollRef = React.useRef<HTMLDivElement | null>(null);
  const notesPaneRef = React.useRef<HTMLDivElement | null>(null);
  const syncShareScroll = React.useCallback((scroller: HTMLElement | null) => {
    if (!scroller) return;
    const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const progress = scroller.scrollTop / max;
    window.markflow.shareScrollTo({ progress });
  }, []);
  const [activeAnchor, setActiveAnchor] = React.useState<string | null>(null);
  const [anchorTopById, setAnchorTopById] = React.useState<Record<string, number>>({});
  const [previewScrollHeight, setPreviewScrollHeight] = React.useState<number>(0);
  const syncingScrollRef = React.useRef<boolean>(false);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const markdownRef = React.useRef(markdown);

  React.useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);

  React.useEffect(() => {
    const off1 = window.markflow.onDocUpdate((p) => {
      setDocPath(p.docPath);
      setMarkdown(p.markdown);
      setLastSavedMarkdown(p.markdown);
    });
    const off2 = window.markflow.onDocSaved((p) => {
      setDocPath(p.docPath);
      setLastSavedMarkdown(markdownRef.current);
    });
    return () => {
      off1();
      off2();
    };
  }, []);

  React.useEffect(() => {
    const offShareClosed = window.markflow.onShareClosed(() => {
      setShareWindowOpen(false);
    });
    return () => offShareClosed();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!parsed) return;
      const next: Record<string, string> = {};
      for (const n of parsed.notes) {
        next[n.id] = await renderInlineMarkdown(n.markdown);
      }
      if (!cancelled) setNoteHtmlById(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed]);

  React.useEffect(() => {
    if (leftMode !== 'preview') return;
    const scroller = previewScrollRef.current;
    const content = previewRef.current;
    if (!scroller || !content) return;
    const anchors = Array.from(content.querySelectorAll<HTMLElement>('[data-anchor]'));
    if (anchors.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => (a.boundingClientRect.top ?? 0) - (b.boundingClientRect.top ?? 0));
        const top = visible[0]?.target as HTMLElement | undefined;
        if (top) setActiveAnchor(top.dataset.anchor ?? null);
      },
      { root: scroller, threshold: 0.2 }
    );
    for (const a of anchors) obs.observe(a);
    return () => obs.disconnect();
  }, [parsed, leftMode]);

  React.useEffect(() => {
    if (!parsed) return;
    if (leftMode !== 'preview') return;
    const scroller = previewScrollRef.current;
    const content = previewRef.current;
    if (!scroller || !content) return;

    let raf = 0;
    const measure = () => {
      const s = previewScrollRef.current;
      const c = previewRef.current;
      if (!s || !c) return;
      const map: Record<string, number> = {};
      const sRect = s.getBoundingClientRect();
      const nodes = Array.from(c.querySelectorAll<HTMLElement>('[data-anchor]'));
      for (const n of nodes) {
        const id = n.dataset.anchor;
        if (!id) continue;
        const r = n.getBoundingClientRect();
        map[id] = (r.top - sRect.top) + s.scrollTop;
      }
      setAnchorTopById(map);
      setPreviewScrollHeight(s.scrollHeight);
    };

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(scroller);
    ro.observe(content);
    raf = requestAnimationFrame(measure);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [parsed, leftMode]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        setLeftMode('preview');
        setShareWindowOpen(true);
        window.markflow.shareOpen({
          docPath,
          markdown,
          displayTarget: 'auto'
        });
        requestAnimationFrame(() => {
          syncShareScroll(previewScrollRef.current);
        });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        window.markflow.docSave({ docPath, markdown });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setLeftMode((m) => (m === 'edit' ? 'preview' : 'edit'));
      }
      if (e.key === 'Escape' && shareWindowOpen) {
        e.preventDefault();
        setShareWindowOpen(false);
        window.markflow.shareClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docPath, markdown, shareWindowOpen]);

  React.useEffect(() => {
    if (!shareWindowOpen) return;
    let raf = 0;
    let lastScrollTop = -1;
    let lastScrollHeight = -1;
    let lastClientHeight = -1;

    const tick = () => {
      const scroller = leftMode === 'preview'
        ? previewScrollRef.current
        : (editorViewRef.current?.scrollDOM ?? null);
      if (scroller) {
        const nextScrollTop = scroller.scrollTop;
        const nextScrollHeight = scroller.scrollHeight;
        const nextClientHeight = scroller.clientHeight;
        if (
          nextScrollTop !== lastScrollTop ||
          nextScrollHeight !== lastScrollHeight ||
          nextClientHeight !== lastClientHeight
        ) {
          lastScrollTop = nextScrollTop;
          lastScrollHeight = nextScrollHeight;
          lastClientHeight = nextClientHeight;
          syncShareScroll(scroller);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shareWindowOpen, leftMode, parsed, markdown, syncShareScroll]);

  const dirty = markdown !== lastSavedMarkdown;
  const cmLightTheme = React.useMemo(
    () =>
      EditorView.theme(
        {
          '&': { backgroundColor: 'rgba(255,255,255,0.70)', color: '#0b1220' },
          '.cm-content': { fontFamily: 'var(--mono)' },
          '.cm-gutters': { backgroundColor: 'rgba(255,255,255,0.60)', color: '#556070', border: 'none' }
        },
        { dark: false }
      ),
    []
  );

  const notesWithTop = React.useMemo(() => {
    const list = parsed?.notes ?? [];
    const idxByAnchor: Record<string, number> = {};
    return list.map((n) => {
      const baseTop = anchorTopById[n.anchorId] ?? 0;
      const i = idxByAnchor[n.anchorId] ?? 0;
      idxByAnchor[n.anchorId] = i + 1;
      return { note: n, top: baseTop + i * 10 };
    });
  }, [parsed, anchorTopById]);

  const notesWithTopForEditor = React.useMemo(() => {
    const view = editorViewRef.current;
    if (!view || !parsed) return [];
    const anchorLineById = new Map<string, number>();
    for (const a of parsed.anchors) anchorLineById.set(a.anchorId, a.sourceRange.startLine);

    const idxByAnchor: Record<string, number> = {};
    const out: { note: (typeof parsed.notes)[number]; top: number }[] = [];
    for (const n of parsed.notes) {
      const line = anchorLineById.get(n.anchorId) ?? n.sourceRange.startLine;
      const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
      const pos = view.state.doc.line(safeLine).from;
      const block = view.lineBlockAt(pos);
      const baseTop = block.top;
      const i = idxByAnchor[n.anchorId] ?? 0;
      idxByAnchor[n.anchorId] = i + 1;
      out.push({ note: n, top: baseTop + i * 10 });
    }
    return out;
  }, [parsed, markdown, leftMode]);

  React.useEffect(() => {
    if (!notesScrollRef.current) return;

    if (leftMode === 'preview') {
      const left = previewScrollRef.current;
      if (!left) return;
      setPreviewScrollHeight(left.scrollHeight);
      const onScroll = () => {
        if (!notesScrollRef.current) return;
        if (syncingScrollRef.current) return;
        syncingScrollRef.current = true;
        notesScrollRef.current.scrollTop = left.scrollTop;
        requestAnimationFrame(() => {
          syncingScrollRef.current = false;
        });
      };
      left.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
      return () => left.removeEventListener('scroll', onScroll);
    }

    const view = editorViewRef.current;
    if (!view) return;
    const left = view.scrollDOM;
    setPreviewScrollHeight(left.scrollHeight);
    const onScroll = () => {
      if (!notesScrollRef.current) return;
      if (syncingScrollRef.current) return;
      syncingScrollRef.current = true;
      notesScrollRef.current.scrollTop = left.scrollTop;
      requestAnimationFrame(() => {
        syncingScrollRef.current = false;
      });
    };
    left.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => left.removeEventListener('scroll', onScroll);
  }, [leftMode, parsed]);

  React.useEffect(() => {
    if (leftMode !== 'edit') return;
    const view = editorViewRef.current;
    if (!view || !parsed) return;

    const anchorLineById = new Map<string, number>();
    for (const a of parsed.anchors) anchorLineById.set(a.anchorId, a.sourceRange.startLine);

    const anchors = parsed.anchors
      .map((a) => {
        const line = anchorLineById.get(a.anchorId) ?? 1;
        const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
        const pos = view.state.doc.line(safeLine).from;
        const top = view.lineBlockAt(pos).top;
        return { id: a.anchorId, top };
      })
      .sort((x, y) => x.top - y.top);

    const onScroll = () => {
      const sTop = view.scrollDOM.scrollTop + 8;
      let cur = anchors[0]?.id ?? null;
      for (const a of anchors) {
        if (a.top <= sTop) cur = a.id;
        else break;
      }
      setActiveAnchor(cur);
    };

    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => view.scrollDOM.removeEventListener('scroll', onScroll);
  }, [leftMode, parsed, markdown]);

  return (
    <div className="appShell">
      <div className="topbar">
        <div className="left">
          <button
            className="btn"
            onClick={async () => {
              await window.markflow.docOpen();
            }}
          >
            Open
          </button>
          <button
            className="btn"
            onClick={async () => {
              await window.markflow.docSave({ docPath, markdown });
            }}
          >
            Save
          </button>
          {dirty ? <span className="pill" style={{ borderColor: 'rgba(251,113,133,0.35)' }}>unsaved</span> : null}
          <span className="pill">Private workspace</span>
        </div>
        <div className="right">
          <button className="btn" onClick={() => toggleTheme()}>
            Theme: {theme}
          </button>
          <button className="btn" onClick={() => setLeftMode((m) => (m === 'edit' ? 'preview' : 'edit'))}>
            Left: {leftMode === 'edit' ? 'Edit' : 'Preview'} (Ctrl/Cmd+E)
          </button>
          <button
            className="btn"
            onClick={() => {
              setLeftMode('preview');
              setShareWindowOpen(true);
              window.markflow.shareOpen({
                docPath,
                markdown,
                displayTarget: 'auto'
              });
              requestAnimationFrame(() => {
                syncShareScroll(previewScrollRef.current);
              });
            }}
          >
            Open Share Window (F5)
          </button>
          {shareWindowOpen ? (
            <button
              className="btn danger"
              onClick={() => {
                setShareWindowOpen(false);
                window.markflow.shareClose();
              }}
            >
              Close Share Window
            </button>
          ) : null}
        </div>
      </div>

      <div className="split appMain" style={{ gridTemplateColumns: '1.8fr 1fr' }}>
        <div className="card">
          {leftMode === 'preview' ? (
            <div ref={previewScrollRef} className="cardBody fullHeight scrollbarHidden">
              <div ref={previewRef} className="markdown" dangerouslySetInnerHTML={{ __html: parsed?.html ?? '' }} />
            </div>
          ) : (
            <div className="cardBody fullHeight" style={{ overflow: 'hidden' }}>
              <CodeMirror
                value={markdown}
                height="100%"
                theme={theme === 'dark' ? oneDark : cmLightTheme}
                extensions={[mdLang()]}
                onCreateEditor={(view: EditorView, _state: EditorState) => {
                  editorViewRef.current = view;
                }}
                onChange={(v) => {
                  setMarkdown(v);
                  window.markflow.docSetMarkdown({ docPath, markdown: v });
                }}
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLine: true,
                  foldGutter: true
                }}
              />
            </div>
          )}
        </div>

        <div className="card">
          <div
            ref={notesScrollRef}
            className="cardBody fullHeight"
            onWheel={(e) => {
              const scroller =
                leftMode === 'preview'
                  ? previewScrollRef.current
                  : (editorViewRef.current?.scrollDOM ?? null);
              if (!scroller) return;
              e.preventDefault();
              scroller.scrollTop += e.deltaY;
              syncShareScroll(scroller);
            }}
            onScroll={(e) => {
              const scroller =
                leftMode === 'preview'
                  ? previewScrollRef.current
                  : (editorViewRef.current?.scrollDOM ?? null);
              if (!scroller) return;
              if (syncingScrollRef.current) return;
              syncingScrollRef.current = true;
              scroller.scrollTop = e.currentTarget.scrollTop;
              syncShareScroll(scroller);
              requestAnimationFrame(() => {
                syncingScrollRef.current = false;
              });
            }}
          >
            <div
              ref={notesPaneRef}
              className="notesAlignContainer"
              style={{ height: Math.max(previewScrollHeight, 1) }}
            >
              {(leftMode === 'preview' ? notesWithTop : notesWithTopForEditor).map(({ note: n, top }) => (
                <div
                  key={n.id}
                  data-note-anchor={n.anchorId}
                  className={`noteItem abs ${activeAnchor && n.anchorId === activeAnchor ? 'active' : ''}`}
                  style={{ top, cursor: 'pointer' }}
                  onClick={() => {
                    if (leftMode === 'preview') {
                      const root = previewRef.current;
                      const scroller = previewScrollRef.current;
                      if (!root || !scroller) return;
                      const target = root.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(n.anchorId)}"]`);
                      if (!target) return;
                      scroller.scrollTo({ top: target.offsetTop, behavior: 'smooth' });
                      requestAnimationFrame(() => {
                        syncShareScroll(scroller);
                      });
                      return;
                    }
                    const view = editorViewRef.current;
                    if (!view || !parsed) return;
                    const anchor = parsed.anchors.find((a) => a.anchorId === n.anchorId);
                    const line = anchor?.sourceRange.startLine ?? n.sourceRange.startLine;
                    const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
                    const pos = view.state.doc.line(safeLine).from;
                    const block = view.lineBlockAt(pos);
                    view.scrollDOM.scrollTop = block.top;
                    syncShareScroll(view.scrollDOM);
                  }}
                >
                  <div className="noteMeta">line {n.sourceRange.startLine}</div>
                  <div dangerouslySetInnerHTML={{ __html: noteHtmlById[n.id] ?? '' }} />
                </div>
              ))}
              {(parsed?.notes ?? []).length === 0 ? (
                <div className="noteItem">No notes found. Use <code>&lt;!-- note: ... --&gt;</code>.</div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
