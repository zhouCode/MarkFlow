import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { useParsedDoc } from './useParsedDoc';
import { renderInlineMarkdown } from '../markdown/parse';
import { useTheme } from './theme';

const starter = `# MarkFlow

这是一个演讲增强版 Markdown 编辑器。

<!-- note: 右侧是讲者注释；投屏观众端不会看到。 -->

## Scroll Talk

向下滚动，注释会高亮跟随当前段落锚点。

<!-- note
多行注释也支持。

- 可以写列表
- 可以强调
-->

---

# Slide Talk

使用 \`---\` 或每个 H1 作为分页起点。
`;

export function EditView() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [docPath, setDocPath] = React.useState<string | null>(null);
  const [markdown, setMarkdown] = React.useState<string>(starter);
  const [lastSavedMarkdown, setLastSavedMarkdown] = React.useState<string>(starter);
  const { parsed, error } = useParsedDoc(markdown);
  const [presentMode, setPresentMode] = React.useState<'present-scroll' | 'present-slides'>('present-scroll');
  const [aspect, setAspect] = React.useState<'4:3' | '16:9'>('16:9');
  const [leftMode, setLeftMode] = React.useState<'preview' | 'edit'>('preview');
  const [noteHtmlById, setNoteHtmlById] = React.useState<Record<string, string>>({});
  const previewScrollRef = React.useRef<HTMLDivElement | null>(null);
  const previewRef = React.useRef<HTMLDivElement | null>(null);
  const notesScrollRef = React.useRef<HTMLDivElement | null>(null);
  const notesPaneRef = React.useRef<HTMLDivElement | null>(null);
  const [activeAnchor, setActiveAnchor] = React.useState<string | null>(null);
  const [anchorTopById, setAnchorTopById] = React.useState<Record<string, number>>({});
  const [previewScrollHeight, setPreviewScrollHeight] = React.useState<number>(0);
  const syncingScrollRef = React.useRef<boolean>(false);
  const editorViewRef = React.useRef<EditorView | null>(null);

  React.useEffect(() => {
    const off1 = window.markflow.onDocUpdate((p) => {
      setDocPath(p.docPath);
      setMarkdown(p.markdown);
      setLastSavedMarkdown(p.markdown);
    });
    const off2 = window.markflow.onDocSaved((p) => {
      setDocPath(p.docPath);
      setLastSavedMarkdown(markdown);
    });
    return () => {
      off1();
      off2();
    };
  }, [markdown]);

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
        window.markflow.presentOpen({
          docPath,
          markdown,
          initialMode: presentMode,
          aspect,
          displayTarget: 'auto'
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docPath, markdown, presentMode, aspect]);

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

  // In edit mode, map notes to editor line positions (no preview DOM involved).
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

  // Sync right pane scroll to whichever "primary scroll source" is active.
  React.useEffect(() => {
    if (!notesScrollRef.current) return;

    // Clean up any previous listener when toggling modes.
    const notesEl = notesScrollRef.current;

    if (leftMode === 'preview') {
      const left = previewScrollRef.current;
      if (!left) return;
      // Ensure height stays accurate even if notes are rendered before the next ResizeObserver tick.
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
      // initial
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

  // In edit mode, compute active anchor by scrollTop and anchor lines.
  React.useEffect(() => {
    if (leftMode !== 'edit') return;
    const view = editorViewRef.current;
    if (!view || !parsed) return;

    const anchorLineById = new Map<string, number>();
    for (const a of parsed.anchors) anchorLineById.set(a.anchorId, a.sourceRange.startLine);

    // Precompute anchors sorted by top.
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
    <div style={{ height: '100%' }}>
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
          <span className="pill">{docPath ?? 'Untitled.md'}</span>
          {dirty ? <span className="pill" style={{ borderColor: 'rgba(251,113,133,0.35)' }}>unsaved</span> : null}
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
            onClick={() => setPresentMode((m) => (m === 'present-scroll' ? 'present-slides' : 'present-scroll'))}
          >
            Mode (WIP): {presentMode === 'present-scroll' ? 'Scroll' : 'Slides'}
          </button>
          <button className="btn" onClick={() => setAspect((a) => (a === '16:9' ? '4:3' : '16:9'))}>
            Aspect (WIP): {aspect}
          </button>
          <button
            className="btn"
            onClick={() => {
              window.markflow.presentOpen({
                docPath,
                markdown,
                initialMode: presentMode,
                aspect,
                displayTarget: 'auto'
              });
            }}
          >
            Present (F5)
          </button>
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: '1.8fr 1fr' }}>
        <div className="card">
          <div className="cardHeader">
            <span>{leftMode === 'edit' ? 'Edit (Left)' : 'Preview (Body)'}</span>
            <span className="statusLine">{parsed ? `${parsed.notes.length} notes, ${parsed.slides.length} slides` : 'parsing...'}</span>
          </div>
          {leftMode === 'preview' ? (
            <div ref={previewScrollRef} className="cardBody scrollbarHidden">
              <div ref={previewRef} className="markdown" dangerouslySetInnerHTML={{ __html: parsed?.html ?? '' }} />
            </div>
          ) : (
            <div className="cardBody" style={{ overflow: 'hidden' }}>
              <CodeMirror
                value={markdown}
                height="100%"
                theme={theme === 'dark' ? oneDark : cmLightTheme}
                extensions={[mdLang()]}
                onCreateEditor={(view: EditorView, _state: EditorState) => {
                  editorViewRef.current = view;
                  // Hide editor scrollbar via CSS; still scrollable.
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
          <div className="cardHeader">
            <span>Notes</span>
            <span className="statusLine">{error ? `error: ${error}` : activeAnchor ? `active: ${activeAnchor}` : ''}</span>
          </div>
          <div
            ref={notesScrollRef}
            className="cardBody scrollbarHidden"
            onWheel={(e) => {
              const scroller =
                leftMode === 'preview'
                  ? previewScrollRef.current
                  : (editorViewRef.current?.scrollDOM ?? null);
              if (!scroller) return;
              // Make the whole page feel like a single scroll area.
              e.preventDefault();
              scroller.scrollTop += e.deltaY;
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
                      target.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
