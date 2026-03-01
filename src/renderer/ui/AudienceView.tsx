import React from 'react';
import { useParsedDoc } from './useParsedDoc';
import { useTheme } from './theme';

type Mode = 'present-scroll' | 'present-slides';
type Aspect = '4:3' | '16:9';

export function AudienceView() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [markdown, setMarkdown] = React.useState<string>('');
  const [mode, setMode] = React.useState<Mode>('present-scroll');
  const [aspect, setAspect] = React.useState<Aspect>('16:9');
  const [slideIndex, setSlideIndex] = React.useState(0);
  const { parsed } = useParsedDoc(markdown);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const offInit = window.markflow.onPresentInit((p) => {
      setMarkdown(p.markdown);
      setMode(p.initialMode);
      setAspect(p.aspect);
    });
    const offDoc = window.markflow.onDocUpdate((p) => setMarkdown(p.markdown));
    const offMode = window.markflow.onPresentSetMode((p) => setMode(p.mode));
    const offAspect = window.markflow.onPresentSetAspect((p) => setAspect(p.aspect));
    const offScroll = window.markflow.onPresentScrollTo((p) => {
      const el = bodyRef.current;
      if (!el) return;
      if (mode !== 'present-scroll') return;
      const progress = typeof p?.progress === 'number' ? p.progress : 0;
      const max = Math.max(1, el.scrollHeight - el.clientHeight);
      el.scrollTop = progress * max;
    });
    const offSlide = window.markflow.onPresentSetSlide((p) => setSlideIndex(p.index));
    return () => {
      offInit();
      offDoc();
      offMode();
      offAspect();
      offScroll();
      offSlide();
    };
  }, [mode]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.markflow.presentClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const html = mode === 'present-slides' ? (parsed?.slideHtml[slideIndex] ?? '') : (parsed?.html ?? '');

  return (
    <div style={{ height: '100%' }}>
      <div className="topbar">
        <div className="left">
          <span className="pill">Audience</span>
          <span className="pill">Mode: {mode === 'present-scroll' ? 'Scroll' : 'Slides'}</span>
          <span className="pill">Aspect: {aspect}</span>
          {mode === 'present-slides' && parsed ? <span className="pill">{slideIndex + 1}/{Math.max(1, parsed.slides.length)}</span> : null}
        </div>
        <div className="right">
          <button className="btn" onClick={() => toggleTheme()}>
            Theme: {theme}
          </button>
          <button className="btn danger" onClick={() => window.markflow.presentClose()}>
            Exit
          </button>
          <span className="statusLine">Clean content only (no notes). Esc: exit</span>
        </div>
      </div>

      <div style={{ height: 'calc(100% - 52px)', padding: 12 }}>
        <div className="frameShell" style={{ height: '100%' }}>
          <div className={`aspectFrame ${aspect === '4:3' ? 'fourThree' : ''}`} style={{ width: 'min(1400px, 100%)' }}>
            <div ref={bodyRef} className="presentBody markdown" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </div>
      </div>
    </div>
  );
}
