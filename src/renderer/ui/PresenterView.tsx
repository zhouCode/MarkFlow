import React from 'react';
import { useParsedDoc } from './useParsedDoc';
import { renderInlineMarkdown } from '../markdown/parse';
import { useTheme } from './theme';

type Mode = 'present-scroll' | 'present-slides';
type Aspect = '4:3' | '16:9';

export function PresenterView() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [docPath, setDocPath] = React.useState<string | null>(null);
  const [markdown, setMarkdown] = React.useState<string>('');
  const [mode, setMode] = React.useState<Mode>('present-scroll');
  const [aspect, setAspect] = React.useState<Aspect>('16:9');
  const [slideIndex, setSlideIndex] = React.useState(0);

  const { parsed } = useParsedDoc(markdown);

  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const [activeAnchor, setActiveAnchor] = React.useState<string | null>(null);
  const [noteHtmlById, setNoteHtmlById] = React.useState<Record<string, string>>({});
  const notesPaneRef = React.useRef<HTMLDivElement | null>(null);
  const notesScrollRef = React.useRef<HTMLDivElement | null>(null);
  const [anchorTopById, setAnchorTopById] = React.useState<Record<string, number>>({});
  const [bodyScrollHeight, setBodyScrollHeight] = React.useState<number>(0);

  React.useEffect(() => {
    const offInit = window.markflow.onPresentInit((p) => {
      setDocPath(p.docPath);
      setMarkdown(p.markdown);
      setMode(p.initialMode);
      setAspect(p.aspect);
    });
    const offDoc = window.markflow.onDocUpdate((p) => {
      setDocPath(p.docPath);
      setMarkdown(p.markdown);
    });
    return () => {
      offInit();
      offDoc();
    };
  }, []);

  React.useEffect(() => {
    // Render note markdown into HTML snippets.
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
    const el = bodyRef.current;
    if (!el) return;
    if (!parsed) return;

    const anchors = Array.from(el.querySelectorAll<HTMLElement>('[data-anchor]'));
    if (anchors.length === 0) return;

    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => (a.boundingClientRect.top ?? 0) - (b.boundingClientRect.top ?? 0));
        const top = visible[0]?.target as HTMLElement | undefined;
        if (top) setActiveAnchor(top.dataset.anchor ?? null);
      },
      { root: el, threshold: 0.2 }
    );
    for (const a of anchors) obs.observe(a);
    return () => obs.disconnect();
  }, [parsed, mode, slideIndex]);

  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (!parsed) return;
    let raf = 0;

    const measure = () => {
      const root = bodyRef.current;
      if (!root) return;
      const map: Record<string, number> = {};
      const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-anchor]'));
      for (const n of nodes) {
        const id = n.dataset.anchor;
        if (!id) continue;
        map[id] = n.offsetTop;
      }
      setAnchorTopById(map);
      setBodyScrollHeight(root.scrollHeight);
    };

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(el);
    raf = requestAnimationFrame(measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [parsed, mode, slideIndex, aspect]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.markflow.presentClose();
      if (e.key === '1' && (e.ctrlKey || e.metaKey)) {
        setAspect('4:3');
        window.markflow.presentSetAspect({ aspect: '4:3' });
      }
      if (e.key === '2' && (e.ctrlKey || e.metaKey)) {
        setAspect('16:9');
        window.markflow.presentSetAspect({ aspect: '16:9' });
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        if (mode !== 'present-slides' || !parsed) return;
        const next = Math.min(parsed.slides.length - 1, slideIndex + 1);
        setSlideIndex(next);
        window.markflow.presentSetSlide({ index: next });
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (mode !== 'present-slides' || !parsed) return;
        const next = Math.max(0, slideIndex - 1);
        setSlideIndex(next);
        window.markflow.presentSetSlide({ index: next });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, parsed, slideIndex]);

  const slideHtml = mode === 'present-slides' ? parsed?.slideHtml[slideIndex] ?? '' : '';
  const bodyHtml = mode === 'present-slides' ? slideHtml : parsed?.html ?? '';

  const notesForCurrent = React.useMemo(() => {
    if (!parsed) return [];
    if (mode === 'present-scroll') return parsed.notes;
    const slide = parsed.slides[slideIndex];
    if (!slide) return [];
    const set = new Set(slide.noteIds);
    return parsed.notes.filter((n) => set.has(n.id));
  }, [parsed, mode, slideIndex]);

  React.useEffect(() => {
    if (!activeAnchor) return;
    const pane = notesPaneRef.current;
    if (!pane) return;
    const el = pane.querySelector<HTMLElement>(`[data-note-anchor="${CSS.escape(activeAnchor)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeAnchor, mode, slideIndex]);

  const notesWithTop = React.useMemo(() => {
    if (!parsed) return [];
    const list = notesForCurrent;
    const idxByAnchor: Record<string, number> = {};
    return list.map((n) => {
      const baseTop = anchorTopById[n.anchorId] ?? 0;
      const i = idxByAnchor[n.anchorId] ?? 0;
      idxByAnchor[n.anchorId] = i + 1;
      return { note: n, top: baseTop + i * 10 };
    });
  }, [parsed, notesForCurrent, anchorTopById]);

  return (
    <div style={{ height: '100%' }}>
      <div className="topbar">
        <div className="left">
          <span className="pill">Presenter</span>
          <span className="pill">{docPath ?? 'Untitled'}</span>
          <button className="btn" onClick={() => toggleTheme()}>
            Theme: {theme}
          </button>
          <button
            className="btn"
            onClick={() => {
              const next: Mode = mode === 'present-scroll' ? 'present-slides' : 'present-scroll';
              setMode(next);
              window.markflow.presentSetMode({ mode: next });
            }}
          >
            Mode: {mode === 'present-scroll' ? 'Scroll' : 'Slides'}
          </button>
          <button
            className="btn"
            onClick={() => {
              const next: Aspect = aspect === '16:9' ? '4:3' : '16:9';
              setAspect(next);
              window.markflow.presentSetAspect({ aspect: next });
            }}
          >
            Aspect: {aspect}
          </button>
          <button className="btn danger" onClick={() => window.markflow.presentClose()}>
            Exit
          </button>
          {mode === 'present-slides' && parsed ? <span className="pill">{slideIndex + 1}/{Math.max(1, parsed.slides.length)}</span> : null}
        </div>
        <div className="right">
          <span className="statusLine">Esc: exit | Ctrl/Cmd+1/2: aspect | Arrows: slides</span>
        </div>
      </div>

      <div className="split">
        <div className="card">
          <div className="cardHeader">
            <span>Content</span>
            <span className="statusLine">{activeAnchor ? `anchor: ${activeAnchor}` : ''}</span>
          </div>
          <div className="cardBody">
            <div className="frameShell">
              <div className={`aspectFrame ${aspect === '4:3' ? 'fourThree' : ''}`}>
                <div
                  ref={bodyRef}
                  className="presentBody markdown"
                  onScroll={(e) => {
                    if (mode !== 'present-scroll') return;
                    const el = e.currentTarget;
                    if (notesScrollRef.current) notesScrollRef.current.scrollTop = el.scrollTop;
                    const max = Math.max(1, el.scrollHeight - el.clientHeight);
                    const progress = el.scrollTop / max;
                    window.markflow.presentScrollTo({ progress });
                  }}
                  dangerouslySetInnerHTML={{ __html: bodyHtml }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="cardHeader">
            <span>Notes</span>
            <span className="statusLine">{notesForCurrent.length} items</span>
          </div>
          <div ref={notesScrollRef} className="cardBody">
            <div
              ref={notesPaneRef}
              className="notesAlignContainer"
              style={{ height: Math.max(bodyScrollHeight, 1) }}
            >
              {notesWithTop.map(({ note: n, top }) => (
                <div
                  key={n.id}
                  data-note-anchor={n.anchorId}
                  className={`noteItem abs ${activeAnchor && n.anchorId === activeAnchor ? 'active' : ''}`}
                  style={{ top }}
                >
                  <div className="noteMeta">
                    line {n.sourceRange.startLine} {'->'} {n.anchorId}
                  </div>
                  <div dangerouslySetInnerHTML={{ __html: noteHtmlById[n.id] ?? '' }} />
                </div>
              ))}
              {notesForCurrent.length === 0 ? <div className="noteItem">No notes for this section.</div> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
