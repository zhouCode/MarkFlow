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
  const [markdown, setMarkdown] = React.useState('');
  const [lastSavedMarkdown, setLastSavedMarkdown] = React.useState('');
  const { parsed } = useParsedDoc(markdown, docPath);
  const [leftMode, setLeftMode] = React.useState<'preview' | 'edit'>('preview');
  const [notesWindowOpen, setNotesWindowOpen] = React.useState(false);
  const [noteHtmlById, setNoteHtmlById] = React.useState<Record<string, string>>({});
  const [contentZoomScale, setContentZoomScale] = React.useState(1);
  const [updateStatus, setUpdateStatus] = React.useState<'idle' | 'checking' | 'available' | 'downloading' | 'ready'>('idle');
  const [updateVersion, setUpdateVersion] = React.useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = React.useState(0);
  const [activeAnchor, setActiveAnchor] = React.useState<string | null>(null);
  const [anchorTopById, setAnchorTopById] = React.useState<Record<string, number>>({});
  const [contentScrollHeight, setContentScrollHeight] = React.useState(1);
  const [currentScrollTop, setCurrentScrollTop] = React.useState(0);
  const previewScrollRef = React.useRef<HTMLDivElement | null>(null);
  const previewRef = React.useRef<HTMLDivElement | null>(null);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const markdownRef = React.useRef(markdown);

  React.useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);

  React.useEffect(() => {
    const offDocUpdate = window.markflow.onDocUpdate((payload) => {
      setDocPath(payload.docPath);
      setMarkdown(payload.markdown);
      setLastSavedMarkdown(payload.markdown);
    });
    const offDocSaved = window.markflow.onDocSaved((payload) => {
      setDocPath(payload.docPath);
      setLastSavedMarkdown(markdownRef.current);
    });
    const offZoom = window.markflow.onContentZoomUpdate((payload) => {
      setContentZoomScale(payload.scale);
    });
    return () => {
      offDocUpdate();
      offDocSaved();
      offZoom();
    };
  }, []);

  React.useEffect(() => {
    const offClosed = window.markflow.onNotesClosed(() => {
      setNotesWindowOpen(false);
    });
    return () => offClosed();
  }, []);

  React.useEffect(() => {
    const offProgress = window.markflow.onUpdateDownloadProgress((payload) => {
      setDownloadProgress(payload.percent);
    });
    return () => offProgress();
  }, []);

  const handleCheckUpdate = React.useCallback(async () => {
    setUpdateStatus('checking');
    const result = await window.markflow.updateCheck();
    if (result.status === 'available') {
      setUpdateStatus('available');
      setUpdateVersion(result.version);
    } else if (result.status === 'not-available') {
      setUpdateStatus('idle');
      alert('当前已是最新版本');
    } else {
      setUpdateStatus('idle');
      alert(`检查更新失败: ${result.message}`);
    }
  }, []);

  const handleDownloadUpdate = React.useCallback(async () => {
    setUpdateStatus('downloading');
    setDownloadProgress(0);
    const result = await window.markflow.updateDownload();
    if (result.success) {
      setUpdateStatus('ready');
    } else {
      setUpdateStatus('available');
      alert(`下载失败: ${result.message ?? '未知错误'}`);
    }
  }, []);

  const handleInstallUpdate = React.useCallback(() => {
    window.markflow.updateInstall();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!parsed) {
        setNoteHtmlById({});
        return;
      }
      const next: Record<string, string> = {};
      for (const note of parsed.notes) {
        next[note.id] = await renderInlineMarkdown(note.markdown);
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
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => (a.boundingClientRect.top ?? 0) - (b.boundingClientRect.top ?? 0));
        const top = visible[0]?.target as HTMLElement | undefined;
        if (top) {
          setActiveAnchor(top.dataset.anchor ?? null);
        }
      },
      { root: scroller, threshold: 0.2 }
    );
    for (const anchor of anchors) observer.observe(anchor);
    return () => observer.disconnect();
  }, [parsed, leftMode, contentZoomScale]);

  React.useEffect(() => {
    if (!parsed || leftMode !== 'preview') return;
    const scroller = previewScrollRef.current;
    const content = previewRef.current;
    if (!scroller || !content) return;

    let raf = 0;
    const measure = () => {
      const nextScroller = previewScrollRef.current;
      const nextContent = previewRef.current;
      if (!nextScroller || !nextContent) return;
      const nextTopById: Record<string, number> = {};
      const scrollerRect = nextScroller.getBoundingClientRect();
      const anchors = Array.from(nextContent.querySelectorAll<HTMLElement>('[data-anchor]'));
      for (const anchor of anchors) {
        const anchorId = anchor.dataset.anchor;
        if (!anchorId) continue;
        const rect = anchor.getBoundingClientRect();
        nextTopById[anchorId] = rect.top - scrollerRect.top + nextScroller.scrollTop;
      }
      setAnchorTopById(nextTopById);
    };

    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    resizeObserver.observe(scroller);
    resizeObserver.observe(content);
    raf = requestAnimationFrame(measure);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
    };
  }, [parsed, leftMode, contentZoomScale]);

  React.useEffect(() => {
    if (leftMode === 'preview') {
      const scroller = previewScrollRef.current;
      const content = previewRef.current;
      if (!scroller || !content) return;

      let raf = 0;
      const syncMetrics = () => {
        setCurrentScrollTop(scroller.scrollTop);
        setContentScrollHeight(scroller.scrollHeight);
      };
      const onScroll = () => syncMetrics();
      const resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(syncMetrics);
      });

      scroller.addEventListener('scroll', onScroll, { passive: true });
      resizeObserver.observe(scroller);
      resizeObserver.observe(content);
      syncMetrics();

      return () => {
        scroller.removeEventListener('scroll', onScroll);
        cancelAnimationFrame(raf);
        resizeObserver.disconnect();
      };
    }

    const view = editorViewRef.current;
    if (!view) return;
    const scroller = view.scrollDOM;
    const content = view.contentDOM;

    let raf = 0;
    const syncMetrics = () => {
      setCurrentScrollTop(scroller.scrollTop);
      setContentScrollHeight(scroller.scrollHeight);
    };
    const onScroll = () => syncMetrics();
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(syncMetrics);
    });

    scroller.addEventListener('scroll', onScroll, { passive: true });
    resizeObserver.observe(scroller);
    resizeObserver.observe(content);
    syncMetrics();

    return () => {
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
    };
  }, [leftMode, parsed, markdown, contentZoomScale]);

  React.useEffect(() => {
    if (leftMode !== 'edit') return;
    const view = editorViewRef.current;
    if (!view || !parsed) return;

    const anchorLineById = new Map<string, number>();
    for (const anchor of parsed.anchors) anchorLineById.set(anchor.anchorId, anchor.sourceRange.startLine);

    const anchors = parsed.anchors
      .map((anchor) => {
        const line = anchorLineById.get(anchor.anchorId) ?? 1;
        const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
        const pos = view.state.doc.line(safeLine).from;
        const top = view.lineBlockAt(pos).top;
        return { id: anchor.anchorId, top };
      })
      .sort((a, b) => a.top - b.top);

    const onScroll = () => {
      const scrollTop = view.scrollDOM.scrollTop + 8;
      let current = anchors[0]?.id ?? null;
      for (const anchor of anchors) {
        if (anchor.top <= scrollTop) current = anchor.id;
        else break;
      }
      setActiveAnchor(current);
    };

    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => view.scrollDOM.removeEventListener('scroll', onScroll);
  }, [leftMode, parsed, markdown, contentZoomScale]);

  const currentScroller = React.useCallback(() => {
    if (leftMode === 'preview') return previewScrollRef.current;
    return editorViewRef.current?.scrollDOM ?? null;
  }, [leftMode]);

  const scrollToProgress = React.useCallback(
    (progress: number) => {
      const scroller = currentScroller();
      if (!scroller) return;
      const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.max(0, Math.min(1, progress)) * max;
    },
    [currentScroller]
  );

  const scrollToAnchor = React.useCallback(
    (anchorId: string) => {
      if (!parsed) return;
      if (leftMode === 'preview') {
        const root = previewRef.current;
        const scroller = previewScrollRef.current;
        if (!root || !scroller) return;
        const target = root.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchorId)}"]`);
        if (!target) return;
        scroller.scrollTo({ top: target.offsetTop, behavior: 'smooth' });
        return;
      }

      const view = editorViewRef.current;
      if (!view) return;
      const anchor = parsed.anchors.find((item) => item.anchorId === anchorId);
      const line = anchor?.sourceRange.startLine ?? 1;
      const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
      const pos = view.state.doc.line(safeLine).from;
      const block = view.lineBlockAt(pos);
      view.scrollDOM.scrollTo({ top: block.top, behavior: 'smooth' });
    },
    [leftMode, parsed]
  );

  React.useEffect(() => {
    const offNavigate = window.markflow.onNotesNavigateTo((payload) => {
      scrollToAnchor(payload.anchorId);
    });
    const offScroll = window.markflow.onNotesScrollTo((payload) => {
      scrollToProgress(payload.progress);
    });
    return () => {
      offNavigate();
      offScroll();
    };
  }, [scrollToAnchor, scrollToProgress]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        window.markflow.contentZoomOut();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
        e.preventDefault();
        window.markflow.contentZoomReset();
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd')
      ) {
        e.preventDefault();
        window.markflow.contentZoomIn();
        return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        setNotesWindowOpen((open) => {
          const next = !open;
          if (next) window.markflow.notesOpen();
          else window.markflow.notesClose();
          return next;
        });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        window.markflow.docSave({ docPath, markdown });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setLeftMode((mode) => (mode === 'edit' ? 'preview' : 'edit'));
        return;
      }
      if (e.key === 'Escape' && notesWindowOpen) {
        e.preventDefault();
        setNotesWindowOpen(false);
        window.markflow.notesClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [docPath, markdown, notesWindowOpen]);

  const dirty = markdown !== lastSavedMarkdown;
  const contentZoomStyle = React.useMemo(
    () => ({ '--content-zoom': String(contentZoomScale) } as React.CSSProperties),
    [contentZoomScale]
  );

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
    const groups = new Map<string, { top: number; notes: typeof list }>();
    for (const note of list) {
      const top = anchorTopById[note.anchorId] ?? 0;
      const existing = groups.get(note.anchorId);
      if (existing) {
        existing.notes.push(note);
      } else {
        groups.set(note.anchorId, { top, notes: [note] });
      }
    }
    return Array.from(groups.entries())
      .map(([anchorId, group]) => ({ anchorId, top: group.top, notes: group.notes }))
      .sort((a, b) => a.top - b.top);
  }, [parsed, anchorTopById]);

  const notesWithTopForEditor = React.useMemo(() => {
    const view = editorViewRef.current;
    if (!view || !parsed) return [];
    const anchorLineById = new Map<string, number>();
    for (const anchor of parsed.anchors) anchorLineById.set(anchor.anchorId, anchor.sourceRange.startLine);

    const groups = new Map<string, { top: number; notes: typeof parsed.notes }>();
    for (const note of parsed.notes) {
      const line = anchorLineById.get(note.anchorId) ?? note.sourceRange.startLine;
      const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
      const pos = view.state.doc.line(safeLine).from;
      const top = view.lineBlockAt(pos).top;
      const existing = groups.get(note.anchorId);
      if (existing) {
        existing.notes.push(note);
      } else {
        groups.set(note.anchorId, { top, notes: [note] });
      }
    }
    return Array.from(groups.entries())
      .map(([anchorId, group]) => ({ anchorId, top: group.top, notes: group.notes }))
      .sort((a, b) => a.top - b.top);
  }, [parsed, markdown, contentZoomScale]);

  const notesGroups = React.useMemo<NotesWindowGroup[]>(() => {
    const source = leftMode === 'preview' ? notesWithTop : notesWithTopForEditor;
    return source.map((group) => ({
      anchorId: group.anchorId,
      top: group.top,
      notes: group.notes.map((note) => ({
        id: note.id,
        line: note.sourceRange.startLine,
        html: noteHtmlById[note.id] ?? ''
      }))
    }));
  }, [leftMode, noteHtmlById, notesWithTop, notesWithTopForEditor]);

  React.useEffect(() => {
    window.markflow.notesUpdate({
      mode: leftMode,
      activeAnchor,
      groups: notesGroups,
      scrollHeight: Math.max(contentScrollHeight, 1),
      scrollTop: currentScrollTop,
      zoomScale: contentZoomScale
    });
  }, [leftMode, activeAnchor, notesGroups, contentScrollHeight, currentScrollTop, contentZoomScale]);

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
          <span className="pill">Notes companion</span>
          <span className="pill">Zoom {Math.round(contentZoomScale * 100)}%</span>
        </div>
        <div className="right">
          <button className="btn" onClick={() => toggleTheme()}>
            Theme: {theme}
          </button>
          <button className="btn" onClick={handleCheckUpdate} disabled={updateStatus === 'checking'}>
            {updateStatus === 'checking' ? '检查中...' : '检查更新'}
          </button>
          {updateStatus === 'available' && (
            <button className="btn" onClick={handleDownloadUpdate}>
              下载 v{updateVersion}
            </button>
          )}
          {updateStatus === 'downloading' && (
            <span className="pill">下载中 {Math.round(downloadProgress)}%</span>
          )}
          {updateStatus === 'ready' && (
            <button className="btn" onClick={handleInstallUpdate}>
              重启安装
            </button>
          )}
          <button className="btn" onClick={() => setLeftMode((mode) => (mode === 'edit' ? 'preview' : 'edit'))}>
            Left: {leftMode === 'edit' ? 'Edit' : 'Preview'} (Ctrl/Cmd+E)
          </button>
          <button
            className={`btn ${notesWindowOpen ? 'danger' : ''}`}
            onClick={() => {
              setNotesWindowOpen((open) => {
                const next = !open;
                if (next) window.markflow.notesOpen();
                else window.markflow.notesClose();
                return next;
              });
            }}
          >
            {notesWindowOpen ? 'Close Notes Window' : 'Open Notes Window (F5)'}
          </button>
        </div>
      </div>

      <div className="appMain editorWorkspace" style={contentZoomStyle}>
        <div className="card zoomCard">
          {leftMode === 'preview' ? (
            <div ref={previewScrollRef} className="cardBody fullHeight scrollbarHidden zoomScroller">
              <div ref={previewRef} className="markdown zoomContent" dangerouslySetInnerHTML={{ __html: parsed?.html ?? '' }} />
            </div>
          ) : (
            <div className="cardBody fullHeight editorPane zoomEditorPane">
              <CodeMirror
                value={markdown}
                theme={theme === 'dark' ? oneDark : cmLightTheme}
                extensions={[mdLang()]}
                onCreateEditor={(view: EditorView, _state: EditorState) => {
                  editorViewRef.current = view;
                  view.dom.style.height = '100%';
                  view.dom.style.display = 'flex';
                  view.dom.style.flexDirection = 'column';
                  view.scrollDOM.style.flex = '1';
                  view.scrollDOM.style.minHeight = '0';
                  view.scrollDOM.style.height = '100%';
                  view.scrollDOM.style.overflow = 'auto';
                  view.contentDOM.style.minHeight = '100%';
                }}
                onChange={(value) => {
                  setMarkdown(value);
                  window.markflow.docSetMarkdown({ docPath, markdown: value });
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
      </div>
    </div>
  );
}
