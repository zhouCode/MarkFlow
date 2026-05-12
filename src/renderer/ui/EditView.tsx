import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { EditorState, Extension, Range } from '@codemirror/state';
import {
  openSearchPanel,
  search,
  searchKeymap,
  setSearchQuery,
  SearchQuery
} from '@codemirror/search';
import { useParsedDoc } from './useParsedDoc';
import { extractLeadingYamlFrontmatter, renderInlineMarkdown } from '../markdown/parse';
import { useTheme } from './theme';

type WorkspaceStatus = 'idle' | 'loading' | 'ready' | 'error';
type BlockMetric = {
  anchorId: string;
  startLine: number;
  endLine: number;
  top: number;
  bottom: number;
};


const DEFAULT_QUICK_OPEN_URL = 'https://remix.ethereum.org/';

type ToastMessage = {
  kind: 'info' | 'error';
  text: string;
};

function normalizeExternalHttpUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function lineCount(value: string): number {
  if (!value) return 0;
  return value.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function leadingMetadataEndLine(markdown: string): number {
  const frontmatter = extractLeadingYamlFrontmatter(markdown);
  if (frontmatter.lineOffset === 0) return 0;
  return lineCount(markdown.slice(0, markdown.length - frontmatter.content.length));
}

function selectedLines(state: EditorState): { from: number; to: number } {
  let from = state.doc.lineAt(state.selection.main.from).number;
  let to = state.doc.lineAt(state.selection.main.to).number;
  if (to < from) [from, to] = [to, from];
  return { from, to };
}


const CODE_KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'bool', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'constructor',
  'continue', 'contract', 'def', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'external', 'false',
  'final', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'interface', 'internal', 'is', 'let', 'library',
  'mapping', 'memory', 'modifier', 'new', 'null', 'override', 'private', 'public', 'pure', 'return', 'returns', 'self',
  'static', 'storage', 'string', 'struct', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'uint', 'uint256',
  'var', 'view', 'void', 'while', 'yield'
]);

function addCodeSyntaxDecorations(lineFrom: number, text: string, ranges: Range<Decoration>[]) {
  const occupied: Array<{ from: number; to: number }> = [];
  const addMark = (from: number, to: number, className: string, reserves = false) => {
    if (to <= from) return;
    ranges.push(Decoration.mark({ class: className }).range(lineFrom + from, lineFrom + to));
    if (reserves) occupied.push({ from, to });
  };
  const isFree = (from: number, to: number) => !occupied.some((span) => from < span.to && to > span.from);

  for (const match of text.matchAll(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g)) {
    const from = match.index ?? 0;
    addMark(from, from + match[0].length, 'mf-code-token-string', true);
  }

  for (const match of text.matchAll(/(\/\/.*|#.*|\/\*.*?\*\/)/g)) {
    const from = match.index ?? 0;
    if (isFree(from, from + match[0].length)) addMark(from, from + match[0].length, 'mf-code-token-comment', true);
  }

  for (const match of text.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (isFree(from, to)) addMark(from, to, 'mf-code-token-number');
  }

  for (const match of text.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const from = match.index ?? 0;
    const word = match[0];
    const to = from + word.length;
    if (isFree(from, to) && CODE_KEYWORDS.has(word)) addMark(from, to, 'mf-code-token-keyword');
  }

  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g)) {
    const from = match.index ?? 0;
    const to = from + match[1].length;
    if (isFree(from, to) && !CODE_KEYWORDS.has(match[1])) addMark(from, to, 'mf-code-token-function');
  }
}


function parseMarkdownImageDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>');
    return end > 0 ? trimmed.slice(1, end).trim() : trimmed;
  }

  const quotedTitle = /\s+["'][^"']*["']\s*$/.exec(trimmed);
  if (quotedTitle) return trimmed.slice(0, quotedTitle.index).trim();
  return trimmed;
}

function findMarkdownImages(text: string): Array<{ from: number; to: number; alt: string; url: string }> {
  return [...text.matchAll(/!\[([^\]\n]*)\]\(([^\n]+?)\)/g)]
    .map((match) => ({
      from: match.index ?? 0,
      to: (match.index ?? 0) + match[0].length,
      alt: match[1] ?? '',
      url: parseMarkdownImageDestination(match[2] ?? '')
    }))
    .filter((image) => image.url.length > 0);
}

type EditorImagePreview = {
  key: string;
  line: number;
  top: number;
  rawUrl: string;
  alt: string;
};
function markdownUnifiedDecorations(
  view: EditorView,
  metadataEndLine: number,
  docPath: string | null,
  imageHeightByLine: Map<number, number>
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const { from: selectedFromLine, to: selectedToLine } = selectedLines(view.state);
  const activeLineNumber = view.state.doc.lineAt(view.state.selection.main.head).number;

  const addLineClass = (lineNumber: number, className: string, attrs?: Record<string, string>) => {
    const line = view.state.doc.line(lineNumber);
    ranges.push(Decoration.line({ class: className, attributes: attrs }).range(line.from));
  };

  let inCodeFence = false;
  let inNoteComment = false;

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    const text = line.text;
    const isActive = lineNumber >= selectedFromLine && lineNumber <= selectedToLine;
    const nearActive = Math.abs(lineNumber - activeLineNumber) <= 1 || isActive;

    if (!inCodeFence && (inNoteComment || /<!--\s*note(?::|\s)/i.test(text))) {
      addLineClass(lineNumber, 'mf-note-source-line');
      if (!/-->/i.test(text)) inNoteComment = true;
      else inNoteComment = false;
      continue;
    }

    if (inNoteComment) {
      addLineClass(lineNumber, 'mf-note-source-line');
      if (/-->/i.test(text)) inNoteComment = false;
      continue;
    }

    if (metadataEndLine > 0 && lineNumber <= metadataEndLine) {
      addLineClass(lineNumber, nearActive ? 'mf-frontmatter-line mf-markers-visible' : 'mf-frontmatter-line');
      continue;
    }

    const fence = /^\s*(```+|~~~+)([^`~]*)$/.exec(text);
    if (fence) {
      addLineClass(lineNumber, nearActive ? 'mf-code-fence mf-code-block-line mf-markers-visible' : 'mf-code-fence mf-code-block-line');
      const markerStart = line.from + (fence.index ?? 0);
      const markerEnd = markerStart + fence[1].length;
      const languageStart = markerEnd;
      if (!nearActive) ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(markerStart, markerEnd));
      if (line.to > languageStart) ranges.push(Decoration.mark({ class: 'mf-code-lang' }).range(languageStart, line.to));
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      addLineClass(lineNumber, 'mf-code-block-line');
      addCodeSyntaxDecorations(line.from, text, ranges);
      continue;
    }

    const thematicBreak = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.exec(text);
    if (thematicBreak) {
      addLineClass(lineNumber, nearActive ? 'mf-hr-line mf-markers-visible' : 'mf-hr-line');
      if (!nearActive) {
        ranges.push(Decoration.mark({ class: 'mf-hr-marker' }).range(line.from, line.to));
      }
      continue;
    }

    if (nearActive) addLineClass(lineNumber, 'mf-markers-visible');

    const unorderedList = /^(\s*)([-*+])(\s+)/.exec(text);
    if (unorderedList) {
      addLineClass(lineNumber, 'mf-list-line');
      if (!nearActive) {
        const markerStart = line.from + unorderedList[1].length;
        ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(markerStart, markerStart + unorderedList[2].length + unorderedList[3].length));
      }
    }

    const images = findMarkdownImages(text);
    if (images.length > 0) {
      const reservedHeight = imageHeightByLine.get(lineNumber) ?? 340;
      addLineClass(lineNumber, 'mf-image-source-line', { style: `--image-reserved-height: ${reservedHeight}px` });
      ranges.push(Decoration.mark({ class: 'mf-image-source-hidden' }).range(line.from, line.to));
    }

    const heading = /^(#{1,6})(\s+)/.exec(text);
    if (heading) {
      addLineClass(lineNumber, `mf-heading-line mf-h${heading[1].length}`);
      if (!nearActive) {
        ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(line.from, line.from + heading[1].length + heading[2].length));
      }
    }

    if (nearActive) continue;

    for (const match of text.matchAll(/(`+)([^`\n]+?)\1/g)) {
      const start = line.from + (match.index ?? 0);
      const markerLength = match[1].length;
      const contentStart = start + markerLength;
      const contentEnd = start + match[0].length - markerLength;
      ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(start, start + markerLength));
      ranges.push(Decoration.mark({ class: 'mf-inline-code' }).range(contentStart, contentEnd));
      ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(start + match[0].length - markerLength, start + match[0].length));
    }

    for (const match of text.matchAll(/(\*\*|__)([^*_\n]+?)\1/g)) {
      const start = line.from + (match.index ?? 0);
      const markerLength = match[1].length;
      ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(start, start + markerLength));
      ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(start + match[0].length - markerLength, start + match[0].length));
    }

    for (const match of text.matchAll(/(?<!\*)\*([^*\n]+?)\*(?!\*)|_([^_\n]+?)_/g)) {
      const start = line.from + (match.index ?? 0);
      ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(start, start + 1));
      ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(start + match[0].length - 1, start + match[0].length));
    }

    for (const match of text.matchAll(/(!?\[)([^\]\n]+)(\]\()([^\)\n]+)(\))/g)) {
      const start = line.from + (match.index ?? 0);
      const openLength = match[1].length;
      const labelLength = match[2].length;
      const midLength = match[3].length;
      const urlLength = match[4].length;
      ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(start, start + openLength));
      ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(start + openLength + labelLength, start + openLength + labelLength + midLength));
      ranges.push(Decoration.mark({ class: 'mf-link-target' }).range(start + openLength + labelLength + midLength, start + openLength + labelLength + midLength + urlLength));
      ranges.push(Decoration.mark({ class: 'mf-md-marker' }).range(start + match[0].length - 1, start + match[0].length));
    }
  }

  return Decoration.set(ranges, true);
}

function unifiedMarkdownExtension(docPath: string | null, imageHeightByLine: Map<number, number>): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = markdownUnifiedDecorations(view, leadingMetadataEndLine(view.state.doc.toString()), docPath, imageHeightByLine);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = markdownUnifiedDecorations(update.view, leadingMetadataEndLine(update.view.state.doc.toString()), docPath, imageHeightByLine);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations
    }
  );
}

function findMarkdownLinkAt(text: string, offset: number): string | null {
  for (const match of text.matchAll(/!?\[[^\]\n]+\]\(([^\)\n]+)\)/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset < start || offset > end) continue;
    const url = match[1]?.trim() ?? '';
    return normalizeExternalHttpUrl(url);
  }
  return null;
}

function findBareUrlAt(text: string, offset: number): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>)]+/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) return normalizeExternalHttpUrl(match[0]);
  }
  return null;
}

function externalLinkClickExtension(openUrl: (url: string) => void): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      if (!(event.metaKey || event.ctrlKey)) return false;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position == null) return false;
      const line = view.state.doc.lineAt(position);
      const offset = position - line.from;
      const url = findMarkdownLinkAt(line.text, offset) ?? findBareUrlAt(line.text, offset);
      if (!url) return false;
      event.preventDefault();
      openUrl(url);
      return true;
    }
  });
}

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
  const [workspaceRestoreResolved, setWorkspaceRestoreResolved] = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [editorViewVersion, setEditorViewVersion] = React.useState(0);
  const [collapsedDirPaths, setCollapsedDirPaths] = React.useState<Set<string>>(() => new Set());
  const { parsed } = useParsedDoc(markdown, docPath);
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
  const [quickOpenUrl, setQuickOpenUrl] = React.useState(DEFAULT_QUICK_OPEN_URL);
  const [quickOpenDraftUrl, setQuickOpenDraftUrl] = React.useState(DEFAULT_QUICK_OPEN_URL);
  const [toast, setToast] = React.useState<ToastMessage | null>(null);
  const [imageUrlByKey, setImageUrlByKey] = React.useState<Record<string, ImageResolveResult>>({});
  const [imageWidthByKey, setImageWidthByKey] = React.useState<Record<string, number>>({});
  const [imageNaturalSizeByKey, setImageNaturalSizeByKey] = React.useState<Record<string, { width: number; height: number }>>({});
  const [activeAnchor, setActiveAnchor] = React.useState<string | null>(null);
  const [contentScrollHeight, setContentScrollHeight] = React.useState(1);
  const [currentScrollTop, setCurrentScrollTop] = React.useState(0);
  const [currentViewportHeight, setCurrentViewportHeight] = React.useState(1);
  const [scrollIndicatorVisible, setScrollIndicatorVisible] = React.useState(false);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const markdownRef = React.useRef(markdown);
  const docPathRef = React.useRef<string | null>(docPath);
  const notesWindowOpenRef = React.useRef(notesWindowOpen);
  const handleOpenFileRef = React.useRef<() => Promise<void>>(async () => {});
  const scrollIndicatorTimerRef = React.useRef<number | null>(null);
  const toastTimerRef = React.useRef<number | null>(null);

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


  React.useEffect(() => {
    let cancelled = false;
    void window.markflow
      .quickOpenGet()
      .then((state) => {
        if (cancelled) return;
        setQuickOpenUrl(state.url);
        setQuickOpenDraftUrl(state.url);
      })
      .catch(() => {
        if (cancelled) return;
        setQuickOpenUrl(DEFAULT_QUICK_OPEN_URL);
        setQuickOpenDraftUrl(DEFAULT_QUICK_OPEN_URL);
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


  const showToast = React.useCallback((message: ToastMessage) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2800);
  }, []);

  React.useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    },
    []
  );

  const openExternalUrl = React.useCallback(
    async (url: string) => {
      const normalized = normalizeExternalHttpUrl(url);
      if (!normalized) {
        showToast({ kind: 'error', text: 'Only http/https URLs can be opened externally.' });
        return false;
      }
      const result = await window.markflow.openExternal({ url: normalized });
      if (!result.success) {
        showToast({ kind: 'error', text: result.message ?? 'Unable to open URL.' });
        return false;
      }
      return true;
    },
    [showToast]
  );

  const handleQuickOpen = React.useCallback(async () => {
    const opened = await openExternalUrl(quickOpenUrl);
    if (opened) showToast({ kind: 'info', text: `Opened page ${quickOpenUrl}` });
  }, [openExternalUrl, quickOpenUrl, showToast]);

  const handleQuickOpenSave = React.useCallback(async () => {
    const normalized = normalizeExternalHttpUrl(quickOpenDraftUrl);
    if (!normalized) {
      showToast({ kind: 'error', text: 'Enter a valid http or https URL.' });
      setQuickOpenDraftUrl(quickOpenUrl);
      return;
    }
    try {
      const saved = await window.markflow.quickOpenSet({ url: normalized });
      setQuickOpenUrl(saved.url);
      setQuickOpenDraftUrl(saved.url);
      showToast({ kind: 'info', text: 'Quick-open URL saved.' });
    } catch (error) {
      showToast({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to save quick-open URL.' });
      setQuickOpenDraftUrl(quickOpenUrl);
    }
  }, [quickOpenDraftUrl, quickOpenUrl, showToast]);

  const handleExportPdf = React.useCallback(async () => {
    const result = await window.markflow.exportPdf({ markdown, docPath });
    if (result.success) {
      showToast({ kind: 'info', text: `PDF exported to ${result.filePath}` });
      return;
    }
    if (result.canceled) {
      showToast({ kind: 'info', text: 'PDF export canceled.' });
      return;
    }
    showToast({ kind: 'error', text: result.message ?? 'PDF export failed.' });
  }, [docPath, markdown, showToast]);

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

  const syncScrollerMetrics = React.useCallback((scroller: HTMLElement) => {
    setCurrentScrollTop(scroller.scrollTop);
    setContentScrollHeight(scroller.scrollHeight);
    setCurrentViewportHeight(scroller.clientHeight);
  }, []);

  const editorImagePreviews = React.useMemo<EditorImagePreview[]>(() => {
    const view = editorViewRef.current;
    if (!view) return [];
    const previews: EditorImagePreview[] = [];
    const doc = view.state.doc;

    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
      const line = doc.line(lineNumber);
      const images = findMarkdownImages(line.text);
      if (images.length === 0) continue;
      const block = view.lineBlockAt(line.to);
      images.forEach((image, index) => {
        previews.push({
          key: `${lineNumber}:${index}:${image.url}`,
          line: lineNumber,
          top: block.top + 10 + index * 8,
          rawUrl: image.url,
          alt: image.alt
        });
      });
    }

    return previews;
  }, [editorViewVersion, markdown, contentZoomScale, currentScrollTop, currentViewportHeight]);

  React.useEffect(() => {
    let cancelled = false;
    const missing = editorImagePreviews.filter((image) => !imageUrlByKey[image.key]);
    if (missing.length === 0) return;

    void Promise.all(missing.map(async (image) => {
      const result = await window.markflow.resolveImageUrl({ url: image.rawUrl, docPath });
      return [image.key, result] as const;
    })).then((entries) => {
      if (cancelled) return;
      setImageUrlByKey((prev) => {
        const next = { ...prev };
        for (const [key, result] of entries) next[key] = result;
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [docPath, editorImagePreviews, imageUrlByKey]);

  const editorBlockMetrics = React.useMemo<BlockMetric[]>(() => {
    const view = editorViewRef.current;
    if (!view || !parsed) return [];
    return parsed.anchors
      .map((anchor) => {
        const safeStartLine = Math.max(1, Math.min(anchor.sourceRange.startLine, view.state.doc.lines));
        const safeEndLine = Math.max(safeStartLine, Math.min(anchor.sourceRange.endLine, view.state.doc.lines));
        const startPos = view.state.doc.line(safeStartLine).from;
        const endPos = view.state.doc.line(safeEndLine).to;
        const startBlock = view.lineBlockAt(startPos);
        const endBlock = view.lineBlockAt(endPos);
        return {
          anchorId: anchor.anchorId,
          startLine: anchor.sourceRange.startLine,
          endLine: anchor.sourceRange.endLine,
          top: startBlock.top,
          bottom: endBlock.bottom
        };
      })
      .sort((a, b) => a.top - b.top);
  }, [editorViewVersion, parsed, markdown, contentZoomScale]);

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

  const adoptWorkspaceDir = React.useCallback(
    async (dirPath: string) => {
      await window.markflow.workspaceStateSet({ dirPath });
      await refreshWorkspace(dirPath);
    },
    [refreshWorkspace]
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await window.markflow.workspaceStateGet();
        if (!cancelled && state.dirPath) await refreshWorkspace(state.dirPath);
      } catch (error) {
        if (cancelled) return;
        setWorkspaceStatus('error');
        setWorkspaceError(error instanceof Error ? error.message : '恢复上次文件夹失败');
      } finally {
        if (!cancelled) setWorkspaceRestoreResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshWorkspace]);

  React.useEffect(() => {
    if (!docPath || !workspaceRestoreResolved) return;
    if (workspaceStatus === 'loading') return;
    if (workspaceDirPath && isPathInsideDir(docPath, workspaceDirPath)) return;
    const dirPath = getParentDirPath(docPath);
    if (!dirPath) return;
    void adoptWorkspaceDir(dirPath);
  }, [adoptWorkspaceDir, docPath, workspaceDirPath, workspaceRestoreResolved, workspaceStatus]);

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
    const view = editorViewRef.current;
    if (!view) return;
    const scroller = view.scrollDOM;
    const content = view.contentDOM;

    let raf = 0;
    const syncMetrics = () => syncScrollerMetrics(scroller);
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
  }, [editorViewVersion, parsed, markdown, contentZoomScale, revealScrollIndicator, syncScrollerMetrics]);

  React.useEffect(() => {
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
  }, [editorViewVersion, parsed, markdown, contentZoomScale]);

  const currentScroller = React.useCallback(() => editorViewRef.current?.scrollDOM ?? null, []);

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
      const view = editorViewRef.current;
      if (!view) return;
      const anchor = parsed.anchors.find((item) => item.anchorId === anchorId);
      const line = anchor?.sourceRange.startLine ?? 1;
      const safeLine = Math.max(1, Math.min(line, view.state.doc.lines));
      const pos = view.state.doc.line(safeLine).from;
      const block = view.lineBlockAt(pos);
      view.scrollDOM.scrollTo({ top: block.top, behavior: 'smooth' });
    },
    [parsed]
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
          '.cm-content': { fontFamily: 'inherit', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' },
          '.cm-gutters': { backgroundColor: 'rgba(255,255,255,0.60)', color: '#556070', border: 'none' }
        },
        { dark: false }
      ),
    []
  );

  const notesWithTopForEditor = React.useMemo(() => {
    if (!parsed) return [];
    const topByAnchorId = new Map(editorBlockMetrics.map((anchor) => [anchor.anchorId, anchor.top]));
    const groups = new Map<string, { top: number; notes: typeof parsed.notes }>();
    for (const note of parsed.notes) {
      const top = topByAnchorId.get(note.anchorId) ?? 0;
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
  }, [editorBlockMetrics, parsed]);

  const notesGroups = React.useMemo<NotesWindowGroup[]>(() => {
    const source = notesWithTopForEditor;
    return source.map((group) => ({
      anchorId: group.anchorId,
      top: group.top,
      notes: group.notes.map((note) => ({
        id: note.id,
        line: note.sourceRange.startLine,
        html: noteHtmlById[note.id] ?? ''
      }))
    }));
  }, [noteHtmlById, notesWithTopForEditor]);

  React.useEffect(() => {
    window.markflow.notesUpdate({
      mode: 'edit',
      activeAnchor,
      groups: notesGroups,
      scrollHeight: Math.max(contentScrollHeight, 1),
      scrollTop: currentScrollTop,
      zoomScale: contentZoomScale
    });
  }, [activeAnchor, notesGroups, contentScrollHeight, currentScrollTop, contentZoomScale]);

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

  const imageRenderedHeight = React.useCallback((key: string) => {
    const width = imageWidthByKey[key] ?? 720;
    const natural = imageNaturalSizeByKey[key];
    if (!natural || natural.width <= 0 || natural.height <= 0) return 300;
    return Math.max(40, Math.round((width / natural.width) * natural.height));
  }, [imageNaturalSizeByKey, imageWidthByKey]);

  const imageReservedHeight = React.useCallback((key: string) => imageRenderedHeight(key) + 44, [imageRenderedHeight]);

  const imageHeightByLine = React.useMemo(() => {
    const heights = new Map<number, number>();
    for (const image of editorImagePreviews) {
      const current = heights.get(image.line) ?? 0;
      heights.set(image.line, Math.max(current, imageReservedHeight(image.key)));
    }
    return heights;
  }, [editorImagePreviews, imageReservedHeight]);

  const beginImageResize = React.useCallback((event: React.PointerEvent, key: string) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = imageWidthByKey[key] ?? 720;
    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.max(120, Math.min(4000, startWidth + moveEvent.clientX - startX));
      setImageWidthByKey((prev) => ({ ...prev, [key]: nextWidth }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }, [imageWidthByKey]);

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
          </div>
          <div className="toolbarGroup searchToolbar" aria-label="Search and replace">
            <button className="btn" title="Find / Replace (Ctrl/Cmd+F)" onClick={() => editorViewRef.current && openSearchPanel(editorViewRef.current)}>
              Find / Replace
            </button>
          </div>
          <div className="toolbarGroup quickOpenToolbar" aria-label="Quick-open website">
            <button className="btn btnPrimary" title="Open configured page" onClick={() => void handleQuickOpen()}>
              Open Page
            </button>
            <input
              className="quickOpenInput"
              value={quickOpenDraftUrl}
              aria-label="Quick-open URL"
              onChange={(event) => setQuickOpenDraftUrl(event.target.value)}
              onBlur={() => void handleQuickOpenSave()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleQuickOpenSave();
                if (event.key === 'Escape') setQuickOpenDraftUrl(quickOpenUrl);
              }}
            />
          </div>
          <div className="toolbarGroup">
            <button className="btn" title="Export current document to PDF" onClick={() => void handleExportPdf()}>
              Export PDF
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
                    void openExternalUrl(appInfo.repositoryUrl);
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
            <div className="cardBody fullHeight editorPane zoomEditorPane unifiedEditorPane">
              <CodeMirror
                value={markdown}
                theme={theme === 'dark' ? oneDark : cmLightTheme}
                extensions={[
                  mdLang(),
                  EditorView.lineWrapping,
                  search({ top: true }),
                  keymap.of([
                    ...searchKeymap,
                    { key: 'Mod-h', run: openSearchPanel },
                    {
                      key: 'Mod-Enter',
                      run: (view) => {
                        const query = new SearchQuery({ search: view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) });
                        view.dispatch({ effects: setSearchQuery.of(query) });
                        return openSearchPanel(view);
                      }
                    }
                  ]),
                  unifiedMarkdownExtension(docPath, imageHeightByLine),
                  externalLinkClickExtension((url) => {
                    void openExternalUrl(url);
                  })
                ]}
                onCreateEditor={(view: EditorView, _state: EditorState) => {
                  editorViewRef.current = view;
                  setEditorViewVersion((version) => version + 1);
                  view.dom.style.height = '100%';
                  view.dom.style.display = 'flex';
                  view.dom.style.flexDirection = 'column';
                  view.scrollDOM.style.flex = '1';
                  view.scrollDOM.style.minHeight = '0';
                  view.scrollDOM.style.height = '100%';
                  view.scrollDOM.style.overflow = 'auto';
                  view.contentDOM.style.minHeight = '100%';
                  void requestAnimationFrame(() => {
                    syncScrollerMetrics(view.scrollDOM);
                  });
                }}
                onUpdate={(update) => {
                  if (update.selectionSet || update.viewportChanged || update.geometryChanged) {
                    setEditorViewVersion((version) => version + 1);
                  }
                }}
                onChange={(value) => {
                  markdownRef.current = value;
                  setMarkdown(value);
                  window.markflow.docSetMarkdown({ docPath, markdown: value });
                }}
                basicSetup={{
                  lineNumbers: false,
                  highlightActiveLine: true,
                  foldGutter: false
                }}
              />
            </div>
            {editorImagePreviews.length > 0 ? (
              <div className="editorImageOverlay" style={{ transform: `translateY(${-currentScrollTop}px)` }} aria-hidden="true">
                {editorImagePreviews.map((image) => {
                  const resolved = imageUrlByKey[image.key];
                  return (
                    <div
                      className={`mf-image-preview ${resolved && !resolved.success ? 'failed' : ''}`}
                      key={image.key}
                      style={{
                        top: image.top,
                        width: imageWidthByKey[image.key] ?? 720,
                        '--image-reserved-height': `${imageReservedHeight(image.key)}px`
                      } as React.CSSProperties}
                    >
                      {!resolved ? 'Loading image…' : resolved.success ? (
                        <>
                          <span className="mf-image-frame" style={{ height: imageRenderedHeight(image.key) }}>
                            <img
                              src={resolved.url}
                              alt={image.alt}
                              onLoad={(event) => {
                                const element = event.currentTarget;
                                const width = element.naturalWidth;
                                const height = element.naturalHeight;
                                if (width > 0 && height > 0) {
                                  setImageNaturalSizeByKey((prev) => ({ ...prev, [image.key]: { width, height } }));
                                }
                              }}
                            />
                            <span
                              className="mf-image-resize-handle"
                              onPointerDown={(event) => beginImageResize(event, image.key)}
                              title="Drag to resize image"
                            />
                          </span>
                        </>
                      ) : (
                        `Image unavailable: ${resolved.message}`
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
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

      {toast ? <div className={`toast ${toast.kind}`}>{toast.text}</div> : null}

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
