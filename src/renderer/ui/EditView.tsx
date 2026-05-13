import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown as mdLang } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { Compartment, type EditorState, type Extension, type Range } from '@codemirror/state';
import { history, historyKeymap, redo, undo } from '@codemirror/commands';
import {
  openSearchPanel,
  search,
  searchKeymap,
  setSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  selectMatches
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

type MenuKind = 'function' | 'edit' | null;

type ToastMessage = {
  kind: 'info' | 'error';
  text: string;
};

type AppTab = { id: 'markdown'; kind: 'markdown'; title: string } | { id: string; kind: 'web'; title: string; url: string };

const editorEditableCompartment = new Compartment();


function createExpandableSearchPanel(view: EditorView) {
  let expanded = false;
  let query = new SearchQuery({ search: '' });

  const searchField = document.createElement('input');
  searchField.className = 'cm-textfield';
  searchField.name = 'search';
  searchField.placeholder = 'Find';
  searchField.setAttribute('aria-label', 'Find');
  searchField.setAttribute('main-field', 'true');

  const replaceField = document.createElement('input');
  replaceField.className = 'cm-textfield replaceField';
  replaceField.name = 'replace';
  replaceField.placeholder = 'Replace';
  replaceField.setAttribute('aria-label', 'Replace');

  const dom = document.createElement('div');
  dom.className = 'cm-search mf-search-panel';

  const expandButton = document.createElement('button');
  expandButton.className = 'cm-button mf-search-expand';
  expandButton.type = 'button';
  expandButton.textContent = '>';
  expandButton.title = 'Show replace';

  const replaceRow = document.createElement('div');
  replaceRow.className = 'mf-search-replace-row';

  const commit = () => {
    const next = new SearchQuery({ search: searchField.value, replace: replaceField.value });
    if (!next.eq(query)) {
      query = next;
      view.dispatch({ effects: setSearchQuery.of(query) });
    }
  };

  const button = (name: string, label: string, onClick: () => void) => {
    const el = document.createElement('button');
    el.className = 'cm-button';
    el.name = name;
    el.type = 'button';
    el.textContent = label;
    el.onclick = onClick;
    return el;
  };

  const setExpanded = (value: boolean) => {
    expanded = value;
    dom.classList.toggle('replaceExpanded', expanded);
    expandButton.textContent = expanded ? '⌄' : '>';
    expandButton.title = expanded ? 'Hide replace' : 'Show replace';
  };

  searchField.oninput = commit;
  replaceField.oninput = commit;
  searchField.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    }
  };
  replaceField.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      replaceNext(view);
    }
  };
  expandButton.onclick = () => setExpanded(!expanded);

  dom.append(
    expandButton,
    searchField,
    button('next', 'next', () => findNext(view)),
    button('prev', 'previous', () => findPrevious(view)),
    button('select', 'all', () => selectMatches(view))
  );
  replaceRow.append(
    replaceField,
    button('replace', 'replace', () => replaceNext(view)),
    button('replaceAll', 'replace all', () => replaceAll(view))
  );
  dom.append(replaceRow);

  setExpanded(false);

  return {
    dom,
    top: true,
    mount() {
      searchField.focus();
      searchField.select();
    },
    update() {
      // The panel owns query updates through its inputs; external query updates are rare here.
    }
  };
}

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
  imageHeightByLine: Map<number, number>,
  presentationMode: boolean
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
    const nearActive = !presentationMode && (Math.abs(lineNumber - activeLineNumber) <= 1 || isActive);

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

function unifiedMarkdownExtension(docPath: string | null, imageHeightByLine: Map<number, number>, presentationMode: boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = markdownUnifiedDecorations(view, leadingMetadataEndLine(view.state.doc.toString()), docPath, imageHeightByLine, presentationMode);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = markdownUnifiedDecorations(update.view, leadingMetadataEndLine(update.view.state.doc.toString()), docPath, imageHeightByLine, presentationMode);
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
    const isImage = match[0].startsWith('!');
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset < start || offset > end) continue;
    const labelStart = start + (isImage ? 2 : 1);
    const labelEnd = start + match[0].indexOf('](');
    const rawUrl = match[1]?.trim() ?? '';
    const urlStart = end - rawUrl.length - 1;
    const onVisibleLabel = offset >= labelStart && offset <= labelEnd;
    const onRawUrl = offset >= urlStart && offset <= end - 1;
    if (!onVisibleLabel && !onRawUrl) continue;
    const url = rawUrl;
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
  const urlAtMouseEvent = (event: MouseEvent, view: EditorView) => {
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position == null) return null;
    const line = view.state.doc.lineAt(position);
    const offset = position - line.from;
    return findMarkdownLinkAt(line.text, offset) ?? findBareUrlAt(line.text, offset);
  };

  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const url = urlAtMouseEvent(event, view);
      if (!url) return false;
      event.preventDefault();
      return true;
    },
    mouseup(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const url = urlAtMouseEvent(event, view);
      if (!url) return false;
      event.preventDefault();
      openUrl(url);
      return true;
    },
    click(event, view) {
      if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
      const url = urlAtMouseEvent(event, view);
      if (!url) return false;
      event.preventDefault();
      return true;
    }
  });
}

function isBlankSelection(state: EditorState): boolean {
  return state.selection.main.empty;
}

function selectedLineRange(state: EditorState) {
  const fromLine = state.doc.lineAt(state.selection.main.from);
  const toLine = state.doc.lineAt(
    state.selection.main.to > state.selection.main.from && state.selection.main.to === state.doc.lineAt(state.selection.main.to).from
      ? state.selection.main.to - 1
      : state.selection.main.to
  );
  return {
    from: fromLine.from,
    to: toLine.to,
    text: state.doc.sliceString(fromLine.from, toLine.to)
  };
}

function wrapSelection(view: EditorView, before: string, after = before, placeholder = 'text') {
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from, selection.to);
  const line = view.state.doc.lineAt(selection.from);
  const lineOffsetFrom = selection.from - line.from;
  const lineOffsetTo = selection.to - line.from;
  const expandedLineText = line.text;
  const markerBefore = expandedLineText.lastIndexOf(before, Math.max(0, lineOffsetFrom));
  const markerAfter = expandedLineText.indexOf(after, lineOffsetTo);
  const canUseSurroundingMarkers =
    markerBefore >= 0 &&
    markerAfter >= lineOffsetTo &&
    markerBefore + before.length <= lineOffsetFrom &&
    (selection.empty || markerAfter >= lineOffsetTo);
  if (canUseSurroundingMarkers) {
    const from = line.from + markerBefore;
    const to = line.from + markerAfter;
    view.dispatch({
      changes: [
        { from: to, to: to + after.length },
        { from, to: from + before.length }
      ],
      selection: {
        anchor: Math.max(from, selection.from - before.length),
        head: Math.max(from, selection.to - before.length)
      },
      scrollIntoView: true
    });
    view.focus();
    return true;
  }
  if (
    selected &&
    view.state.sliceDoc(Math.max(0, selection.from - before.length), selection.from) === before &&
    view.state.sliceDoc(selection.to, Math.min(view.state.doc.length, selection.to + after.length)) === after
  ) {
    view.dispatch({
      changes: [
        { from: selection.to, to: selection.to + after.length },
        { from: selection.from - before.length, to: selection.from }
      ],
      selection: { anchor: selection.from - before.length, head: selection.to - before.length },
      scrollIntoView: true
    });
    view.focus();
    return true;
  }
  if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
    const inner = selected.slice(before.length, selected.length - after.length);
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: inner },
      selection: { anchor: selection.from, head: selection.from + inner.length },
      scrollIntoView: true
    });
    view.focus();
    return true;
  }
  const insert = selected || placeholder;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: `${before}${insert}${after}` },
    selection: {
      anchor: selected ? selection.from + before.length : selection.from + before.length,
      head: selected ? selection.to + before.length : selection.from + before.length + placeholder.length
    },
    scrollIntoView: true
  });
  view.focus();
  return true;
}

function toggleHeading(view: EditorView, level: 1 | 2 | 3) {
  const range = selectedLineRange(view.state);
  const target = `${'#'.repeat(level)} `;
  const lines = range.text.split('\n');
  const everyTarget = lines.every((line) => new RegExp(`^\\s{0,3}${'#'.repeat(level)}\\s+`).test(line));
  const insert = lines
    .map((line) => {
      if (everyTarget) return line.replace(/^\s{0,3}#{1,6}\s+/, '');
      const withoutHeading = line.replace(/^\s{0,3}#{1,6}\s+/, '');
      return `${target}${withoutHeading}`;
    })
    .join('\n');
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from, head: range.from + insert.length },
    scrollIntoView: true
  });
  view.focus();
  return true;
}

function toggleLinePrefix(view: EditorView, prefix: '- ' | '1. ') {
  const range = selectedLineRange(view.state);
  const lines = range.text.split('\n');
  const bulletPattern = /^(\s*)[-*+]\s+/;
  const numberedPattern = /^(\s*)\d+\.\s+/;
  const targetPattern = prefix === '- ' ? bulletPattern : numberedPattern;
  const everyTarget = lines.every((line) => targetPattern.test(line));
  const insert = lines
    .map((line) => {
      if (everyTarget) return line.replace(targetPattern, '$1');
      const withoutList = line.replace(bulletPattern, '$1').replace(numberedPattern, '$1');
      return withoutList.replace(/^(\s*)/, `$1${prefix}`);
    })
    .join('\n');
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from, head: range.from + insert.length },
    scrollIntoView: true
  });
  view.focus();
  return true;
}

function toggleTaskList(view: EditorView) {
  const range = selectedLineRange(view.state);
  const lines = range.text.split('\n');
  const everyTask = lines.every((line) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line));
  const insert = lines
    .map((line) => {
      if (everyTask) return line.replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, '$1');
      if (/^\s*[-*+]\s+/.test(line)) return line.replace(/^(\s*[-*+]\s+)/, '$1[ ] ');
      return line.replace(/^(\s*)/, '$1- [ ] ');
    })
    .join('\n');
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from, head: range.from + insert.length },
    scrollIntoView: true
  });
  view.focus();
  return true;
}

function insertMarkdownLink(view: EditorView) {
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from, selection.to) || 'link text';
  const insert = `[${selected}](https://)`;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: selection.from + insert.length - 8, head: selection.from + insert.length - 1 },
    scrollIntoView: true
  });
  view.focus();
  return true;
}

function insertMarkdownCodeBlock(view: EditorView) {
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from, selection.to);
  const insert = `\n\`\`\`solidity\n${selected || '// code'}\n\`\`\`\n`;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: {
      anchor: selected ? selection.from + insert.length : selection.from + 13,
      head: selected ? selection.from + insert.length : selection.from + 20
    },
    scrollIntoView: true
  });
  view.focus();
  return true;
}

function createShortcutLabel(platform: string) {
  const isMac = platform === 'darwin';
  const joiner = isMac ? '' : '+';
  const parts = {
    mod: isMac ? '⌘' : 'Ctrl',
    shift: isMac ? '⇧' : 'Shift',
    alt: isMac ? '⌥' : 'Alt'
  };
  return (...keys: Array<'mod' | 'shift' | 'alt' | string>) => keys.map((key) => (key in parts ? parts[key as keyof typeof parts] : key)).join(joiner);
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
  const [webTabs, setWebTabs] = React.useState<WebTabState[]>([]);
  const [activeTabId, setActiveTabId] = React.useState<string>('markdown');
  const [addressDraft, setAddressDraft] = React.useState('');
  const [presentationMode, setPresentationMode] = React.useState(false);
  const [openMenu, setOpenMenu] = React.useState<MenuKind>(null);
  const addressInputRef = React.useRef<HTMLInputElement | null>(null);
  const activeTabIdRef = React.useRef<string>('markdown');
  const webHostRef = React.useRef<HTMLDivElement | null>(null);
  const [toast, setToast] = React.useState<ToastMessage | null>(null);
  const [imageUrlByKey, setImageUrlByKey] = React.useState<Record<string, ImageResolveResult>>({});
  const [imageWidthByKey, setImageWidthByKey] = React.useState<Record<string, number>>({});
  const [imageNaturalSizeByKey, setImageNaturalSizeByKey] = React.useState<Record<string, { width: number; height: number }>>({});
  const [activeAnchor, setActiveAnchor] = React.useState<string | null>(null);
  const [contentScrollHeight, setContentScrollHeight] = React.useState(1);
  const [currentScrollTop, setCurrentScrollTop] = React.useState(0);
  const [currentViewportHeight, setCurrentViewportHeight] = React.useState(1);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const markdownRef = React.useRef(markdown);
  const docPathRef = React.useRef<string | null>(docPath);
  const notesWindowOpenRef = React.useRef(notesWindowOpen);
  const handleOpenFileRef = React.useRef<() => Promise<void>>(async () => {});
  const toastTimerRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);

  React.useEffect(() => {
    docPathRef.current = docPath;
  }, [docPath]);

  React.useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

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

  const openInternalWebTab = React.useCallback(
    async (url: string, reuseExisting = false) => {
      const normalized = normalizeExternalHttpUrl(url);
      if (!normalized) {
        showToast({ kind: 'error', text: 'Only http/https URLs can be opened in MarkFlow tabs.' });
        return false;
      }
      const result = await window.markflow.webTabCreate({ url: normalized, reuseExisting });
      if (!result.success) {
        showToast({ kind: 'error', text: result.message ?? 'Unable to open tab.' });
        return false;
      }
      setActiveTabId(result.tab.id);
      setAddressDraft(result.tab.url);
      return true;
    },
    [showToast]
  );

  const handleQuickOpen = React.useCallback(async () => {
    const opened = await openInternalWebTab(quickOpenUrl, true);
    if (opened) showToast({ kind: 'info', text: `Opened tab ${quickOpenUrl}` });
  }, [openInternalWebTab, quickOpenUrl, showToast]);

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

  React.useEffect(() => {
    let cancelled = false;
    void window.markflow.webTabList().then((result) => {
      if (!cancelled && result.success) setWebTabs(result.tabs);
    });
    const offUpdated = window.markflow.onWebTabUpdated((tab) => {
      setWebTabs((prev) => {
        const exists = prev.some((item) => item.id === tab.id);
        return exists ? prev.map((item) => (item.id === tab.id ? tab : item)) : [...prev, tab];
      });
      setActiveTabId((current) => {
        if (current === tab.id) setAddressDraft(tab.url);
        return current;
      });
    });
    const offList = window.markflow.onWebTabListChanged((tabs) => {
      setWebTabs(tabs);
      setActiveTabId((current) => (current !== 'markdown' && !tabs.some((tab) => tab.id === current) ? 'markdown' : current));
    });
    return () => {
      cancelled = true;
      offUpdated();
      offList();
    };
  }, []);

  React.useEffect(() => {
    const activeWebTab = webTabs.find((tab) => tab.id === activeTabId);
    if (activeWebTab) setAddressDraft(activeWebTab.url);
  }, [activeTabId, webTabs]);

  React.useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    view.dispatch({ effects: editorEditableCompartment.reconfigure(EditorView.editable.of(!presentationMode)) });
  }, [presentationMode, editorViewVersion]);

  const syncActiveWebTabBounds = React.useCallback(() => {
    const currentActiveTabId = activeTabIdRef.current;
    if (currentActiveTabId === 'markdown') return;
    const host = webHostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    void window.markflow.webTabSetBounds({
      id: currentActiveTabId,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }, []);

  React.useEffect(() => {
    if (activeTabId === 'markdown') {
      void window.markflow.webTabFocus({ id: null });
      return;
    }
    void window.markflow.webTabFocus({ id: activeTabId }).then((result) => {
      if (result.success) setAddressDraft(result.tab.url);
    });
    syncActiveWebTabBounds();
    const onResize = () => syncActiveWebTabBounds();
    window.addEventListener('resize', onResize);
    const observer = webHostRef.current ? new ResizeObserver(syncActiveWebTabBounds) : null;
    if (webHostRef.current && observer) observer.observe(webHostRef.current);
    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  }, [activeTabId, syncActiveWebTabBounds]);

  React.useLayoutEffect(() => {
    if (activeTabId === 'markdown') return;
    syncActiveWebTabBounds();
  }, [activeTabId, syncActiveWebTabBounds]);

  const focusTab = React.useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const closeWebTab = React.useCallback(async (id: string) => {
    const result = await window.markflow.webTabClose({ id });
    if (!result.success) showToast({ kind: 'error', text: result.message ?? 'Unable to close tab.' });
    setActiveTabId((current) => (current === id ? 'markdown' : current));
  }, [showToast]);

  const focusAddressBar = React.useCallback(() => {
    if (activeTabIdRef.current === 'markdown') setActiveTabId(webTabs[0]?.id ?? 'markdown');
    window.requestAnimationFrame(() => {
      addressInputRef.current?.focus();
      addressInputRef.current?.select();
    });
  }, [webTabs]);

  const focusFirstWebTab = React.useCallback(() => {
    setActiveTabId(webTabs[0]?.id ?? 'markdown');
  }, [webTabs]);

  const closeCurrentWebTab = React.useCallback(() => {
    const currentActiveTabId = activeTabIdRef.current;
    if (currentActiveTabId === 'markdown') return;
    void closeWebTab(currentActiveTabId);
  }, [closeWebTab]);

  const navigateActiveWebTab = React.useCallback(async () => {
    if (activeTabId === 'markdown') return;
    const normalized = normalizeExternalHttpUrl(addressDraft);
    if (!normalized) {
      showToast({ kind: 'error', text: 'Enter a valid http or https URL.' });
      return;
    }
    const result = await window.markflow.webTabNavigate({ id: activeTabId, url: normalized });
    if (!result.success) showToast({ kind: 'error', text: result.message ?? 'Unable to navigate tab.' });
  }, [activeTabId, addressDraft, showToast]);

  const adjustActiveWebTabZoom = React.useCallback(async (action: 'in' | 'out' | 'reset') => {
    const currentActiveTabId = activeTabIdRef.current;
    if (currentActiveTabId === 'markdown') return false;
    const result = await window.markflow.webTabAdjustZoom({ id: currentActiveTabId, action });
    if (!result.success) {
      showToast({ kind: 'error', text: result.message ?? 'Unable to adjust web zoom.' });
      return false;
    }
    return true;
  }, [showToast]);

  const runEditorCommand = React.useCallback((command: (view: EditorView) => boolean) => {
    const view = editorViewRef.current;
    if (!view) return false;
    setActiveTabId('markdown');
    window.requestAnimationFrame(() => {
      command(view);
    });
    return true;
  }, []);

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
  }, [editorViewVersion, parsed, markdown, contentZoomScale, syncScrollerMetrics]);

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
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const shiftMod = mod && e.shiftKey;
      const editorActive = activeTabIdRef.current === 'markdown';

      if (mod && !e.shiftKey && e.key === '1') {
        e.preventDefault();
        setActiveTabId('markdown');
        return;
      }
      if (mod && !e.shiftKey && e.key === '2') {
        e.preventDefault();
        focusFirstWebTab();
        return;
      }
      if (shiftMod && key === 'r') {
        e.preventDefault();
        void handleQuickOpen();
        return;
      }
      if (mod && !e.shiftKey && key === 'l') {
        e.preventDefault();
        focusAddressBar();
        return;
      }
      if (mod && !e.shiftKey && key === 'w') {
        e.preventDefault();
        closeCurrentWebTab();
        return;
      }
      if ((e.altKey && key === 'm') || (mod && key === ',')) {
        e.preventDefault();
        setOpenMenu((current) => (current === 'function' ? null : 'function'));
        return;
      }
      if (e.altKey && key === 'e') {
        e.preventDefault();
        setOpenMenu((current) => (current === 'edit' ? null : 'edit'));
        return;
      }
      if (shiftMod && key === 'p') {
        e.preventDefault();
        setPresentationMode((value) => !value);
        return;
      }
      if (editorActive && mod && !e.shiftKey && key === 'b') {
        e.preventDefault();
        runEditorCommand((view) => wrapSelection(view, '**', '**', 'bold'));
        return;
      }
      if (editorActive && mod && !e.shiftKey && key === 'i') {
        e.preventDefault();
        runEditorCommand((view) => wrapSelection(view, '*', '*', 'italic'));
        return;
      }
      if (editorActive && shiftMod && key === 'x') {
        e.preventDefault();
        runEditorCommand((view) => wrapSelection(view, '~~', '~~', 'strikethrough'));
        return;
      }
      if (editorActive && mod && !e.shiftKey && key === 'k') {
        e.preventDefault();
        runEditorCommand(insertMarkdownLink);
        return;
      }
      if (editorActive && shiftMod && e.key === '7') {
        e.preventDefault();
        runEditorCommand((view) => toggleLinePrefix(view, '- '));
        return;
      }
      if (editorActive && shiftMod && e.key === '8') {
        e.preventDefault();
        runEditorCommand((view) => toggleLinePrefix(view, '1. '));
        return;
      }
      if (editorActive && shiftMod && key === 't') {
        e.preventDefault();
        runEditorCommand(toggleTaskList);
        return;
      }
      if (editorActive && shiftMod && key === 'c') {
        e.preventDefault();
        runEditorCommand(insertMarkdownCodeBlock);
        return;
      }
      if (editorActive && mod && e.altKey && e.key === '1') {
        e.preventDefault();
        runEditorCommand((view) => toggleHeading(view, 1));
        return;
      }
      if (editorActive && mod && e.altKey && e.key === '2') {
        e.preventDefault();
        runEditorCommand((view) => toggleHeading(view, 2));
        return;
      }
      if (editorActive && mod && e.altKey && e.key === '3') {
        e.preventDefault();
        runEditorCommand((view) => toggleHeading(view, 3));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        if (activeTabIdRef.current === 'markdown') window.markflow.contentZoomOut();
        else void adjustActiveWebTabZoom('out');
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
        e.preventDefault();
        if (activeTabIdRef.current === 'markdown') window.markflow.contentZoomReset();
        else void adjustActiveWebTabZoom('reset');
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd')
      ) {
        e.preventDefault();
        if (activeTabIdRef.current === 'markdown') window.markflow.contentZoomIn();
        else void adjustActiveWebTabZoom('in');
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
  }, [
    adjustActiveWebTabZoom,
    closeCurrentWebTab,
    focusAddressBar,
    focusFirstWebTab,
    handleQuickOpen,
    runEditorCommand
  ]);

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
  const appTabs = React.useMemo<AppTab[]>(() => [
    { id: 'markdown', kind: 'markdown', title: currentDocName || 'Markdown' },
    ...webTabs.map((tab) => ({ id: tab.id, kind: 'web' as const, title: tab.title || tab.url, url: tab.url }))
  ], [currentDocName, webTabs]);
  const activeWebTab = React.useMemo(() => webTabs.find((tab) => tab.id === activeTabId) ?? null, [activeTabId, webTabs]);
  const currentWorkspaceName = React.useMemo(() => getBaseName(workspaceDirPath), [workspaceDirPath]);
  const shortcut = React.useMemo(() => createShortcutLabel(window.markflow.platform), []);
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

  const toggleNotes = React.useCallback(() => {
    setNotesWindowOpen((open) => {
      const next = !open;
      notesWindowOpenRef.current = next;
      if (next) window.markflow.notesOpen();
      else window.markflow.notesClose();
      return next;
    });
  }, []);

  const closeMenus = React.useCallback(() => setOpenMenu(null), []);

  const menuMouseDown = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault();
  }, []);

  const runMenuAction = React.useCallback((action: () => void) => {
    closeMenus();
    action();
  }, [closeMenus]);

  const menuItem = React.useCallback((label: string, shortcut: string, action: () => void, disabled = false) => (
    <button className="menuItem" disabled={disabled} onMouseDown={menuMouseDown} onClick={() => runMenuAction(action)}>
      <span>{label}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </button>
  ), [menuMouseDown, runMenuAction]);

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
      <div className={`topbar compactChrome ${openMenu ? 'menuOpen' : ''}`}>
        <div className="toolbarGroup menuGroup">
          <button className="btn" title="Function menu (Alt+M / Ctrl/Cmd+,)" onClick={() => setOpenMenu((menu) => (menu === 'function' ? null : 'function'))}>
            ☰ Function
          </button>
          {openMenu === 'function' ? (
            <div className="menuDropdown" onMouseLeave={closeMenus}>
              {menuItem('Open File', shortcut('mod', 'O'), () => void handleOpenFile())}
              {menuItem('Open Folder', '', () => void handleOpenFolder())}
              {menuItem('Switch to Markdown', shortcut('mod', '1'), () => setActiveTabId('markdown'))}
              {menuItem('Switch to Web', shortcut('mod', '2'), focusFirstWebTab)}
              {menuItem('Open Remix', shortcut('shift', 'mod', 'R'), () => void handleQuickOpen())}
              {menuItem('Focus Address', shortcut('mod', 'L'), focusAddressBar)}
              {menuItem('Close Web Tab', shortcut('mod', 'W'), closeCurrentWebTab, activeTabId === 'markdown')}
              {menuItem('Toggle Files', '', () => setSidebarOpen((open) => !open))}
              {menuItem('Toggle Present', shortcut('shift', 'mod', 'P'), () => setPresentationMode((value) => !value))}
              {menuItem('Export PDF', '', () => void handleExportPdf())}
              {menuItem('Theme', '', toggleTheme)}
              {menuItem('About', 'F1', () => setAboutOpen((open) => !open))}
              {menuItem(updateButtonLabel, '', handleUpdateAction, updateStatus === 'checking')}
              {menuItem('Toggle Notes', 'F5', toggleNotes)}
              {menuItem(`Zoom Sync ${notesSettings.syncZoomWithEdit ? '✓' : ''}`, '', () => void updateNotesSettings({ syncZoomWithEdit: !notesSettings.syncZoomWithEdit }))}
              {menuItem(`Dock Sync ${notesSettings.syncDockWithEdit ? '✓' : ''}`, '', () => void updateNotesSettings({ syncDockWithEdit: !notesSettings.syncDockWithEdit }))}
            </div>
          ) : null}
        </div>

        <div className="toolbarGroup menuGroup">
          <button className="btn" title="Edit menu (Alt+E)" onClick={() => setOpenMenu((menu) => (menu === 'edit' ? null : 'edit'))}>
            ✎ Edit
          </button>
          {openMenu === 'edit' ? (
            <div className="menuDropdown" onMouseLeave={closeMenus}>
              {menuItem('Undo', shortcut('mod', 'Z'), () => runEditorCommand(undo))}
              {menuItem('Redo', shortcut('shift', 'mod', 'Z'), () => runEditorCommand(redo))}
              <div className="menuSeparator" />
              {menuItem('Bold', shortcut('mod', 'B'), () => runEditorCommand((view) => wrapSelection(view, '**', '**', 'bold')))}
              {menuItem('Italic', shortcut('mod', 'I'), () => runEditorCommand((view) => wrapSelection(view, '*', '*', 'italic')))}
              {menuItem('Strikethrough', shortcut('shift', 'mod', 'X'), () => runEditorCommand((view) => wrapSelection(view, '~~', '~~', 'strikethrough')))}
              {menuItem('Inline Code', shortcut('mod', 'E'), () => runEditorCommand((view) => wrapSelection(view, '`', '`', 'code')))}
              {menuItem('Link', shortcut('mod', 'K'), () => runEditorCommand(insertMarkdownLink))}
              {menuItem('Code Block', shortcut('shift', 'mod', 'C'), () => runEditorCommand(insertMarkdownCodeBlock))}
              <div className="menuSeparator" />
              {menuItem('Heading 1', shortcut('alt', 'mod', '1'), () => runEditorCommand((view) => toggleHeading(view, 1)))}
              {menuItem('Heading 2', shortcut('alt', 'mod', '2'), () => runEditorCommand((view) => toggleHeading(view, 2)))}
              {menuItem('Heading 3', shortcut('alt', 'mod', '3'), () => runEditorCommand((view) => toggleHeading(view, 3)))}
              {menuItem('Bullet List', shortcut('shift', 'mod', '7'), () => runEditorCommand((view) => toggleLinePrefix(view, '- ')))}
              {menuItem('Numbered List', shortcut('shift', 'mod', '8'), () => runEditorCommand((view) => toggleLinePrefix(view, '1. ')))}
              {menuItem('Task List', shortcut('shift', 'mod', 'T'), () => runEditorCommand(toggleTaskList))}
            </div>
          ) : null}
        </div>

        <button
          className={`btn toggleBtn ${presentationMode ? 'active' : ''}`}
          title={`Toggle classroom presentation mode (${shortcut('shift', 'mod', 'P')})`}
          onClick={() => setPresentationMode((value) => !value)}
        >
          Present
        </button>

        <div className="tabBar inlineTabs" role="tablist" aria-label="Open content tabs">
          {appTabs.map((tab) => (
            <button
              key={tab.id}
              className={`tabButton ${activeTabId === tab.id ? 'active' : ''}`}
              onClick={() => focusTab(tab.id)}
              title={tab.kind === 'web' ? tab.url : tab.title}
            >
              <span className="tabTitle">{tab.kind === 'web' && webTabs.find((item) => item.id === tab.id)?.loading ? '● ' : ''}{tab.title}</span>
              {tab.kind === 'web' ? (
                <span
                  className="tabClose"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeWebTab(tab.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      void closeWebTab(tab.id);
                    }
                  }}
                  aria-label={`Close ${tab.title}`}
                >
                  ×
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <input
          ref={addressInputRef}
          className="quickOpenInput compactUrlInput"
          value={activeTabId === 'markdown' ? quickOpenDraftUrl : addressDraft}
          aria-label={activeTabId === 'markdown' ? 'Quick-open URL' : 'Current tab URL'}
          onChange={(event) => {
            if (activeTabId === 'markdown') setQuickOpenDraftUrl(event.target.value);
            else setAddressDraft(event.target.value);
          }}
          onBlur={() => {
            if (activeTabId === 'markdown') void handleQuickOpenSave();
            else syncActiveWebTabBounds();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (activeTabId === 'markdown') {
                void handleQuickOpenSave().then(() => handleQuickOpen());
              } else {
                void navigateActiveWebTab();
              }
            }
            if (event.key === 'Escape' && activeTabId === 'markdown') setQuickOpenDraftUrl(quickOpenUrl);
          }}
        />
        <button
          className="btn btnPrimary"
          title={activeTabId === 'markdown' ? 'Open URL in new tab' : 'Navigate current tab'}
          onClick={() => {
            if (activeTabId === 'markdown') void handleQuickOpen();
            else void navigateActiveWebTab();
          }}
        >
          {activeTabId === 'markdown' ? 'New Tab' : 'Open'}
        </button>
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

      <div className={`appMain editorWorkspace ${presentationMode ? 'presentationMode' : ''}`} style={contentZoomStyle}>
        <div className={`workspaceSplit ${sidebarOpen ? 'withSidebar' : 'withoutSidebar'} ${activeTabId === 'markdown' ? '' : 'webActive'}`}>
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
                  editorEditableCompartment.of(EditorView.editable.of(!presentationMode)),
                  history(),
                  search({ top: true, createPanel: createExpandableSearchPanel }),
                  keymap.of([
                    ...historyKeymap,
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
                  unifiedMarkdownExtension(docPath, imageHeightByLine, presentationMode),
                  externalLinkClickExtension((url) => {
                    void openInternalWebTab(url);
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
                  if (presentationMode) return;
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
          </div>
          {activeTabId !== 'markdown' ? <div ref={webHostRef} className="webTabHost" aria-label="Internal web tab content" /> : null}
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
          <span className="pill" title={activeTabId === 'markdown' ? 'Document zoom' : 'Web page zoom (Ctrl/Cmd +/-/0)'}>
            Zoom {activeTabId === 'markdown' ? Math.round(contentZoomScale * 100) : Math.round((activeWebTab?.zoomFactor ?? 1) * 100)}%
          </span>
          {updateStatus === 'downloading' ? <span className="pill">Downloading {Math.round(downloadProgress)}%</span> : null}
        </div>
      </div>
    </div>
  );
}
