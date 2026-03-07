import React from 'react';
import { useParsedDoc } from './useParsedDoc';
import { useTheme } from './theme';

export function AudienceView() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [markdown, setMarkdown] = React.useState<string>('');
  const [contentZoomScale, setContentZoomScale] = React.useState(1);
  const { parsed } = useParsedDoc(markdown, { debounceMs: 10 });
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const latestProgressRef = React.useRef(0);

  const applyScrollProgress = React.useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    el.scrollTop = latestProgressRef.current * max;
  }, []);

  React.useEffect(() => {
    const offInit = window.markflow.onShareInit((p) => {
      latestProgressRef.current = typeof p.progress === 'number' ? p.progress : 0;
      setContentZoomScale(typeof p.zoomScale === 'number' ? p.zoomScale : 1);
      setMarkdown(p.markdown);
    });
    const offDoc = window.markflow.onDocUpdate((p) => setMarkdown(p.markdown));
    const offScroll = window.markflow.onShareScrollTo((p) => {
      latestProgressRef.current = typeof p?.progress === 'number' ? p.progress : 0;
      applyScrollProgress();
    });
    const offZoom = window.markflow.onContentZoomUpdate((p) => {
      setContentZoomScale(p.scale);
    });
    return () => {
      offInit();
      offDoc();
      offScroll();
      offZoom();
    };
  }, [applyScrollProgress]);

  React.useLayoutEffect(() => {
    applyScrollProgress();
  }, [parsed, applyScrollProgress, contentZoomScale]);

  React.useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      applyScrollProgress();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyScrollProgress]);

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
      if (e.key === 'Escape') window.markflow.shareClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const contentZoomStyle = React.useMemo(
    () => ({ '--content-zoom': String(contentZoomScale) } as React.CSSProperties),
    [contentZoomScale]
  );

  return (
    <div className="appShell">
      <div className="topbar">
        <div className="left">
          <span className="pill">Share Window</span>
          <span className="pill">Zoom {Math.round(contentZoomScale * 100)}%</span>
        </div>
        <div className="right">
          <button className="btn" onClick={() => toggleTheme()}>
            Theme: {theme}
          </button>
          <button className="btn danger" onClick={() => window.markflow.shareClose()}>
            Close
          </button>
        </div>
      </div>

      <div className="audienceStage appMain" style={contentZoomStyle}>
        <div className="frameShell shareFrameShell">
          <div className="shareFrame">
            <div ref={bodyRef} className="presentBody">
              <div className="markdown" dangerouslySetInnerHTML={{ __html: parsed?.html ?? '' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
