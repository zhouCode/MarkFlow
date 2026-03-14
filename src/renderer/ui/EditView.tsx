import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { useParsedDoc } from './useParsedDoc';
import { renderInlineMarkdown } from '../markdown/parse';
import { useTheme } from './theme';

type WorkspaceStatus = 'idle' | 'loading' | 'ready' | 'error';

function getParentDirPath(filePath: string): string | null {
  const normalized = filePath.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (separatorIndex < 0) return null;
  if (separatorIndex === 0) return normalized.slice(0, 1);
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, separatorIndex);
}

function getBaseName(filePath: string | null): string {
  if (!filePath) return 'Untitled';
  const normalized = filePath.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

function isPathInsideDir(filePath: string, dirPath: string): boolean {
  const normalizedFile = filePath.replace(/[\\/]+$/, '');
  const normalizedDir = dirPath.replace(/[\\/]+$/, '');
  if (normalizedFile === normalizedDir) return true;
  const separator = normalizedDir.includes('\\') ? '\\' : '/';
  return normalizedFile.startsWith(`${normalizedDir}${separator}`);
}

export function EditView() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [docPath, setDocPath] = React.useState<string | null>(null);
  const [markdown, setMarkdown] = React.useState('');
  const [lastSavedMarkdown, setLastSavedMarkdown] = React.useState('');
  const [workspaceDirPath, setWorkspaceDirPath] = React.useState<string | null>(null);
  const [workspaceEntries, setWorkspaceEntries] = React.useState<FileBrowserEntry[]>([]);
  const [workspaceStatus, setWorkspaceStatus] = React.useState<WorkspaceStatus>('idle');
  const [workspaceError, setWorkspaceError] = React.useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [collapsedDirPaths, setCollapsedDirPaths] = React.useState<Set<string>>(() => new Set());
  const { parsed } = useParsedDoc(markdown, docPath);
  const [leftMode, setLeftMode] = React.useState<'preview' | 'edit'>('preview');
  const [notesWindowOpen, setNotesWindowOpen] = React.useState(false);
  const [notesSettings, setNotesSettings] = React.useState<NotesWindowSettings>({
    syncZoomWithEdit: true,
    syncDockWithEdit: true
  });
  const [noteHtmlById, setNoteHtmlById] = React.useState<Record<string, string>>({});
  const [contentZoomScale, setContentZoomScale] = React.useState(1);
  const [updateStatus, setUpdateStatus] = React.useState<'idle' | 'checking' | 'available' | 'downloading' | 'ready'>('idle');
  const [updateVersion, setUpdateVersion] = React.useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = React.useState(0);
  const [appInfo, setAppInfo] = React.useState<AppInfo | null>(null);
  const [aboutOpen, setAboutOpen] = React.useState(false);
  const [activeAnchor, setActiveAnchor] = React.useState<string | null>(null);
  const [anchorTopById, setAnchorTopById] = React.useState<Record<string, number>>({});
  const [contentScrollHeight, setContentScrollHeight] = React.useState(1);
  const [currentScrollTop, setCurrentScrollTop] = React.useState(0);
  const [currentViewportHeight, setCurrentViewportHeight] = React.useState(1);
  const [scrollIndicatorVisible, setScrollIndicatorVisible] = React.useState(false);
  const previewScrollRef = React.useRef<HTMLDivElement | null>(null);
  const previewRef = React.useRef<HTMLDivElement | null>(null);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const markdownRef = React.useRef(markdown);
  const docPathRef = React.useRef<string | null>(docPath);
  const notesWindowOpenRef = React.useRef(notesWindowOpen);
  const handleOpenFileRef = React.useRef<() => Promise<void>>(async () => {});
  const scrollIndicatorTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);

  React.useEffect(() => {
    docPathRef.current = docPath;
  }, [docPath]);

  React.useEffect(() => {
    notesWindowOpenRef.current = notesWindowOpen;
  }, [notesWindowOpen]);

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
      notesWindowOpenRef.current = false;
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

  React.useEffect(() => {
    let cancelled = false;
    void window.markflow
      .notesSettingsGet()
      .then((settings) => {
        if (!cancelled) setNotesSettings(settings);
      })
      .catch((error) => {
        if (cancelled) return;
        alert(error instanceof Error ? error.message : '读取 Notes 设置失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void window.markflow.appInfo().then((info) => {
      if (!cancelled) setAppInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateNotesSettings = React.useCallback(async (input: Partial<NotesWindowSettings>) => {
    try {
      const nextSettings = await window.markflow.notesSettingsSet(input);
      setNotesSettings(nextSettings);
    } catch (error) {
      alert(error instanceof Error ? error.message : '更新 Notes 设置失败');
    }
  }, []);

  const revealScrollIndicator = React.useCallback(() => {
    setScrollIndicatorVisible(true);
    if (scrollIndicatorTimerRef.current !== null) window.clearTimeout(scrollIndicatorTimerRef.current);
    scrollIndicatorTimerRef.current = window.setTimeout(() => {
      setScrollIndicatorVisible(false);
      scrollIndicatorTimerRef.current = null;
    }, 700);
  }, []);

  React.useEffect(
    () => () => {
      if (scrollIndicatorTimerRef.current !== null) window.clearTimeout(scrollIndicatorTimerRef.current);
    },
    []
  );

  const refreshWorkspace = React.useCallback(async (dirPath: string) => {
    setWorkspaceStatus('loading');
    setWorkspaceError(null);
    try {
      const result = await window.markflow.folderList({ dirPath });
      setWorkspaceDirPath(result.dirPath);
      setWorkspaceEntries(result.entries);
      setCollapsedDirPaths((prev) => {
        const next = new Set(
          result.entries.filter((entry) => entry.kind === 'directory' && !prev.has(entry.path)).map((entry) => entry.path)
        );
        for (const existingPath of prev) {
          if (result.entries.some((entry) => entry.path === existingPath && entry.kind === 'directory')) next.add(existingPath);
        }
        return next;
      });
      setWorkspaceStatus('ready');
    } catch (error) {
      setWorkspaceDirPath(dirPath);
      setWorkspaceEntries([]);
      setCollapsedDirPaths(new Set());
      setWorkspaceStatus('error');
      setWorkspaceError(error instanceof Error ? error.message : '读取文件夹失败');
    }
  }, []);

  React.useEffect(() => {
    if (!docPath) return;
    if (workspaceDirPath && isPathInsideDir(docPath, workspaceDirPath)) return;
    const dirPath = getParentDirPath(docPath);
    if (!dirPath) return;
    void refreshWorkspace(dirPath);
  }, [docPath, refreshWorkspace, workspaceDirPath]);

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

  const saveCurrentDocument = React.useCallback(async () => {
    const result = await window.markflow.docSave({ docPath, markdown });
    return Boolean(result?.docPath);
  }, [docPath, markdown]);

  const confirmSwitchIfDirty = React.useCallback(async () => {
    const dirty = markdown !== lastSavedMarkdown;
    if (!dirty) return true;

    const shouldSave = window.confirm('当前文档有未保存修改。点击“确定”先保存，再切换文件。');
    if (shouldSave) {
      const saved = await saveCurrentDocument();
      if (!saved) return false;
      return true;
    }

    return window.confirm('确定放弃当前未保存修改并切换文件吗？');
  }, [lastSavedMarkdown, markdown, saveCurrentDocument]);

  const handleOpenFile = React.useCallback(async () => {
    if (!(await confirmSwitchIfDirty())) return;
    try {
      await window.markflow.docOpen();
    } catch (error) {
      alert(error instanceof Error ? error.message : '打开文件失败');
    }
  }, [confirmSwitchIfDirty]);

  React.useEffect(() => {
    handleOpenFileRef.current = handleOpenFile;
  }, [handleOpenFile]);

  const handleOpenFolder = React.useCallback(async () => {
    try {
      const result = await window.markflow.folderOpen();
      if (!result) return;
      setSidebarOpen(true);
      setCollapsedDirPaths(new Set());
      await refreshWorkspace(result.dirPath);
    } catch (error) {
      alert(error instanceof Error ? error.message : '打开文件夹失败');
    }
  }, [refreshWorkspace]);

  const handleOpenWorkspaceEntry = React.useCallback(
    async (entry: FileBrowserEntry) => {
      if (entry.kind !== 'file' || !entry.isMarkdown) return;
      if (!(await confirmSwitchIfDirty())) return;
      try {
        await window.markflow.docOpenPath({ filePath: entry.path });
      } catch (error) {
        alert(error instanceof Error ? error.message : '打开文件失败');
      }
    },
    [confirmSwitchIfDirty]
  );

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
        setCurrentViewportHeight(scroller.clientHeight);
      };
      const onScroll = () => {
        syncMetrics();
        revealScrollIndicator();
      };
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
        setCurrentViewportHeight(scroller.clientHeight);
      };
      const onScroll = () => {
        syncMetrics();
        revealScrollIndicator();
      };
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
  }, [leftMode, parsed, markdown, contentZoomScale, revealScrollIndicator]);

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
        const next = !notesWindowOpenRef.current;
        notesWindowOpenRef.current = next;
        setNotesWindowOpen(next);
        if (next) window.markflow.notesOpen();
        else window.markflow.notesClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void handleOpenFileRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        window.markflow.docSave({ docPath: docPathRef.current, markdown: markdownRef.current });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarOpen((open) => !open);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setLeftMode((mode) => (mode === 'edit' ? 'preview' : 'edit'));
        return;
      }
      if (e.key === 'F1') {
        e.preventDefault();
        setAboutOpen((open) => !open);
        return;
      }
      if (e.key === 'Escape' && notesWindowOpenRef.current) {
        e.preventDefault();
        notesWindowOpenRef.current = false;
        setNotesWindowOpen(false);
        window.markflow.notesClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const dirty = markdown !== lastSavedMarkdown;
  const entryByPath = React.useMemo(() => new Map(workspaceEntries.map((entry) => [entry.path, entry])), [workspaceEntries]);
  const visibleWorkspaceEntries = React.useMemo(
    () =>
      workspaceEntries.filter((entry) => {
        let currentParentPath = entry.parentPath;
        while (currentParentPath) {
          if (collapsedDirPaths.has(currentParentPath)) return false;
          currentParentPath = entryByPath.get(currentParentPath)?.parentPath ?? null;
        }
        return true;
      }),
    [collapsedDirPaths, entryByPath, workspaceEntries]
  );
  const workspaceMarkdownCount = React.useMemo(
    () => workspaceEntries.filter((entry) => entry.isMarkdown).length,
    [workspaceEntries]
  );
  const workspaceFolderCount = React.useMemo(
    () => workspaceEntries.filter((entry) => entry.kind === 'directory').length,
    [workspaceEntries]
  );
  const currentDocName = React.useMemo(() => getBaseName(docPath), [docPath]);
  const currentWorkspaceName = React.useMemo(() => getBaseName(workspaceDirPath), [workspaceDirPath]);
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

  const handleUpdateAction = React.useCallback(() => {
    if (updateStatus === 'available') {
      void handleDownloadUpdate();
      return;
    }
    if (updateStatus === 'ready') {
      handleInstallUpdate();
      return;
    }
    if (updateStatus === 'idle') {
      void handleCheckUpdate();
    }
  }, [handleCheckUpdate, handleDownloadUpdate, handleInstallUpdate, updateStatus]);

  const updateButtonLabel = React.useMemo(() => {
    if (updateStatus === 'checking') return 'Checking...';
    if (updateStatus === 'available') return updateVersion ? `Update ${updateVersion}` : 'Update';
    if (updateStatus === 'downloading') return `Update ${Math.round(downloadProgress)}%`;
    if (updateStatus === 'ready') return 'Restart';
    return 'Update';
  }, [downloadProgress, updateStatus, updateVersion]);

  const showScrollIndicator = contentScrollHeight > currentViewportHeight + 8;
  const scrollIndicatorMetrics = React.useMemo(() => {
    const scrollable = Math.max(contentScrollHeight, 1);
    const viewport = Math.max(1, currentViewportHeight);
    const maxScrollTop = Math.max(1, scrollable - viewport);
    const thumbHeight = Math.max(28, (viewport / scrollable) * viewport);
    const maxThumbOffset = Math.max(0, viewport - thumbHeight);
    const thumbTop = maxThumbOffset === 0 ? 0 : (currentScrollTop / maxScrollTop) * maxThumbOffset;
    return { thumbHeight, thumbTop };
  }, [contentScrollHeight, currentScrollTop, currentViewportHeight]);

  React.useEffect(() => {
    if (!workspaceDirPath) {
      setCollapsedDirPaths(new Set());
    }
  }, [workspaceDirPath]);

  React.useEffect(() => {
    if (!docPath) return;
    const currentEntry = entryByPath.get(docPath);
    if (!currentEntry) return;
    setCollapsedDirPaths((prev) => {
      const next = new Set(prev);
      let changed = false;
      let currentParentPath = currentEntry.parentPath;
      while (currentParentPath) {
        if (next.delete(currentParentPath)) changed = true;
        currentParentPath = entryByPath.get(currentParentPath)?.parentPath ?? null;
      }
      return changed ? next : prev;
    });
  }, [docPath, entryByPath]);

  return (
    <div className="appShell">
      <div className="topbar">
        <div className="topbarMain">
          <div className="toolbarGroup">
            <button
              className="btn"
              title="Open File (Ctrl/Cmd+O)"
              onClick={() => {
                void handleOpenFile();
              }}
            >
              Open
            </button>
            <button
              className="btn"
              title="Open Folder"
              onClick={() => {
                void handleOpenFolder();
              }}
            >
              Folder
            </button>
          </div>
          <div className="toolbarGroup">
            <button
              className={`btn toggleBtn ${sidebarOpen ? 'active' : ''}`}
              title="Toggle Files Sidebar (Ctrl/Cmd+B)"
              onClick={() => setSidebarOpen((open) => !open)}
            >
              Files
            </button>
            <button
              className="btn"
              title="Toggle Edit / Preview (Ctrl/Cmd+E)"
              onClick={() => setLeftMode((mode) => (mode === 'edit' ? 'preview' : 'edit'))}
            >
              {leftMode === 'edit' ? 'Preview' : 'Edit'}
            </button>
          </div>
        </div>
        <div className="topbarAside">
          <div className="toolbarGroup">
            <button
              className={`btn ${aboutOpen ? 'active' : ''}`}
              title="About MarkFlow (F1)"
              onClick={() => setAboutOpen((open) => !open)}
            >
              About
            </button>
            <button className="btn" title="Toggle Theme" onClick={() => toggleTheme()}>
              Theme
            </button>
            <button
              className={`btn ${updateStatus === 'ready' ? 'danger' : ''}`}
              title={updateStatus === 'ready' ? 'Restart to Install Update' : 'Check for Updates'}
              onClick={handleUpdateAction}
              disabled={updateStatus === 'checking'}
            >
              {updateButtonLabel}
            </button>
          </div>
          <div className="toolbarGroup">
            <button
              className={`btn toggleBtn ${notesWindowOpen ? 'active' : ''}`}
              title="Toggle Notes Window (F5)"
              onClick={() => {
                setNotesWindowOpen((open) => {
                  const next = !open;
                  notesWindowOpenRef.current = next;
                  if (next) window.markflow.notesOpen();
                  else window.markflow.notesClose();
                  return next;
                });
              }}
            >
              Notes
            </button>
            <button
              className={`btn toggleBtn ${notesSettings.syncZoomWithEdit ? 'active' : ''}`}
              title="Toggle Notes zoom sync with editor"
              onClick={() => {
                void updateNotesSettings({ syncZoomWithEdit: !notesSettings.syncZoomWithEdit });
              }}
            >
              Zoom Sync
            </button>
            <button
              className={`btn toggleBtn ${notesSettings.syncDockWithEdit ? 'active' : ''}`}
              title="Toggle Notes dock sync with editor"
              onClick={() => {
                void updateNotesSettings({ syncDockWithEdit: !notesSettings.syncDockWithEdit });
              }}
            >
              Dock Sync
            </button>
          </div>
        </div>
      </div>

      {aboutOpen ? (
        <div className="aboutOverlay" onClick={() => setAboutOpen(false)}>
          <div className="aboutPanel" onClick={(event) => event.stopPropagation()}>
            <div className="aboutHeader">
              <div>
                <div className="aboutTitle">About MarkFlow</div>
                <div className="aboutCaption">Application Information</div>
              </div>
              <button className="btn" onClick={() => setAboutOpen(false)}>
                Close
              </button>
            </div>
            <div className="aboutBody">
              <div className="aboutRow">
                <span className="aboutLabel">Author</span>
                <span className="aboutValue">{appInfo?.author ?? 'Loading...'}</span>
              </div>
              <div className="aboutRow">
                <span className="aboutLabel">Version</span>
                <span className="aboutValue">{appInfo?.version ?? 'Loading...'}</span>
              </div>
              <div className="aboutRow">
                <span className="aboutLabel">Repository</span>
                <button
                  className="aboutLink"
                  onClick={() => {
                    if (!appInfo?.repositoryUrl) return;
                    void window.markflow.openExternal({ url: appInfo.repositoryUrl });
                  }}
                >
                  {appInfo?.repositoryUrl ?? 'Loading...'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="appMain editorWorkspace" style={contentZoomStyle}>
        <div className={`workspaceSplit ${sidebarOpen ? 'withSidebar' : 'withoutSidebar'}`}>
          {sidebarOpen ? (
            <aside className="card workspaceSidebar">
              <div className="cardHeader workspaceSidebarHeader">
                <div className="workspaceSidebarTitle">
                  <span>Files</span>
                  <span className="workspaceSidebarPath" title={workspaceDirPath ?? 'No folder selected'}>
                    {workspaceDirPath ?? 'No folder selected'}
                  </span>
                </div>
                <div className="workspaceSidebarActions">
                  {workspaceDirPath ? (
                    <button
                      className="sidebarBtn iconBtn"
                      onClick={() => {
                        if (!workspaceDirPath) return;
                        void refreshWorkspace(workspaceDirPath);
                      }}
                      title="Refresh files"
                      aria-label="Refresh files"
                    >
                      ↻
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="cardBody fullHeight workspaceSidebarBody">
                {workspaceStatus === 'loading' ? <div className="workspaceEmpty">Loading files...</div> : null}
                {workspaceStatus === 'error' ? <div className="workspaceEmpty">{workspaceError ?? '读取文件夹失败'}</div> : null}
                {workspaceStatus === 'idle' ? (
                  <div className="workspaceEmpty">Open a folder to browse files in the current directory.</div>
                ) : null}
                {workspaceStatus === 'ready' && visibleWorkspaceEntries.length === 0 ? (
                  <div className="workspaceEmpty">This folder does not contain any markdown files.</div>
                ) : null}
                {workspaceStatus === 'ready' && visibleWorkspaceEntries.length > 0 ? (
                  <>
                    <div className="workspaceSummary">
                      {workspaceMarkdownCount} markdown in {workspaceFolderCount} folders
                    </div>
                    <div className="workspaceList">
                      {visibleWorkspaceEntries.map((entry) => {
                        const isDirectory = entry.kind === 'directory';
                        const isCurrent = !isDirectory && entry.path === docPath;
                        const isCollapsed = isDirectory && collapsedDirPaths.has(entry.path);
                        return (
                          <button
                            key={entry.path}
                            className={`workspaceItem ${isCurrent ? 'active' : ''} ${isDirectory ? 'directory' : 'file'}`}
                            onClick={() => {
                              if (isDirectory) {
                                setCollapsedDirPaths((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(entry.path)) next.delete(entry.path);
                                  else next.add(entry.path);
                                  return next;
                                });
                                return;
                              }
                              void handleOpenWorkspaceEntry(entry);
                            }}
                            title={entry.path}
                            style={{ '--tree-depth': String(entry.depth) } as React.CSSProperties}
                          >
                            <span className={`workspaceItemChevron ${isCollapsed ? 'collapsed' : ''}`}>
                              {isDirectory ? (isCollapsed ? '▸' : '▾') : '·'}
                            </span>
                            <span className="workspaceItemLabel">
                              {isDirectory ? <span className="workspaceFolderIcon" aria-hidden="true" /> : null}
                              <span className="workspaceItemName">{entry.name}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : null}
              </div>
            </aside>
          ) : null}
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
                    markdownRef.current = value;
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
            {showScrollIndicator ? (
              <div className={`scrollIndicator ${scrollIndicatorVisible ? 'visible' : ''}`} aria-hidden="true">
                <div
                  className="scrollIndicatorThumb"
                  style={{
                    height: `${scrollIndicatorMetrics.thumbHeight}px`,
                    transform: `translateY(${scrollIndicatorMetrics.thumbTop}px)`
                  }}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="subbar bottomBar">
        <div className="left">
          <span className="pill">
            {currentDocName}
            {dirty ? <span className="dirtyMark"> •</span> : null}
          </span>
          {workspaceDirPath ? <span className="pill">Folder {currentWorkspaceName}</span> : null}
        </div>
        <div className="right">
          <span className="pill">Zoom {Math.round(contentZoomScale * 100)}%</span>
          {updateStatus === 'downloading' ? <span className="pill">Downloading {Math.round(downloadProgress)}%</span> : null}
        </div>
      </div>
    </div>
  );
}
