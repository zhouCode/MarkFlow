import React from 'react';
import { useTheme } from './theme';

const EMPTY_STATE: NotesWindowState = {
  mode: 'preview',
  activeAnchor: null,
  groups: [],
  scrollHeight: 1,
  scrollTop: 0,
  zoomScale: 1
};

export function NotesView() {
  useTheme();
  const showCustomHeader = window.markflow.platform === 'darwin';
  const [state, setState] = React.useState<NotesWindowState>(EMPTY_STATE);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const syncingScrollRef = React.useRef(false);

  React.useEffect(() => {
    const offUpdate = window.markflow.onNotesUpdate((payload) => {
      setState(payload);
    });
    return () => offUpdate();
  }, []);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    syncingScrollRef.current = true;
    el.scrollTop = state.scrollTop;
    requestAnimationFrame(() => {
      syncingScrollRef.current = false;
    });
  }, [state.scrollTop, state.scrollHeight]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        window.markflow.notesClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const contentZoomStyle = React.useMemo(
    () => ({ '--content-zoom': String(state.zoomScale) } as React.CSSProperties),
    [state.zoomScale]
  );
  const noteCount = React.useMemo(
    () => state.groups.reduce((total, group) => total + group.notes.length, 0),
    [state.groups]
  );

  return (
    <div className="notesWindowShell" style={contentZoomStyle}>
      <div className="notesWindowFrame">
        {showCustomHeader ? (
          <div className="notesWindowHeader">
            <div className="notesWindowTitle">Notes</div>
          </div>
        ) : null}
        <div
          ref={scrollRef}
          className="notesWindowScroller"
          onScroll={(e) => {
            if (syncingScrollRef.current) return;
            const max = Math.max(1, e.currentTarget.scrollHeight - e.currentTarget.clientHeight);
            window.markflow.notesScrollTo({ progress: e.currentTarget.scrollTop / max });
          }}
        >
          <div className="notesWindowCanvas" style={{ height: Math.max(state.scrollHeight, 1) }}>
            {state.groups.map((group) => (
              <div
                key={group.anchorId}
                className={`noteItem abs ${state.activeAnchor === group.anchorId ? 'active' : ''}`}
                style={{ top: group.top, cursor: 'pointer' }}
                onClick={() => window.markflow.notesNavigateTo({ anchorId: group.anchorId })}
              >
                {group.notes.map((note) => (
                  <div key={note.id} className="noteEntry">
                    <div className="noteMeta">
                      {state.mode === 'edit' ? 'code' : 'preview'} line {note.line}
                    </div>
                    <div dangerouslySetInnerHTML={{ __html: note.html }} />
                  </div>
                ))}
              </div>
            ))}
            {state.groups.length === 0 ? (
              <div className="noteItem notesWindowEmpty">
                No notes found. Use <code>&lt;!-- note: ... --&gt;</code>.
              </div>
            ) : null}
          </div>
        </div>
        <div className="subbar notesWindowFooter">
          <div className="left">
            <span className="pill">{state.groups.length} anchors</span>
            <span className="pill">{noteCount} notes</span>
          </div>
          <div className="right">
            <span className="pill">Zoom {Math.round(state.zoomScale * 100)}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
