import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { common } from 'lowlight';
import solidityPackage from 'highlightjs-solidity';
import { nanoid } from 'nanoid';

const solidity = (solidityPackage as { solidity?: unknown }).solidity;

const highlightLanguages = solidity
  ? { ...common, solidity: solidity as typeof common[string] }
  : common;

const highlightAliases = {
  sol: 'solidity'
};

type MdRoot = any;
type MdNode = any;

export type Aspect = '4:3' | '16:9';
export type PresentMode = 'present-scroll' | 'present-slides';

export type BlockAnchor = {
  anchorId: string;
  kind: string;
  sourceRange: { startLine: number; endLine: number };
};

export type Note = {
  id: string;
  anchorId: string;
  sourceRange: { startLine: number; endLine: number };
  raw: string;
  markdown: string;
  order: number;
};

export type Slide = {
  id: string;
  sourceRange: { startLine: number; endLine: number };
  anchorIds: string[];
  noteIds: string[];
};

export type ParsedDoc = {
  html: string;
  anchors: BlockAnchor[];
  notes: Note[];
  slides: Slide[];
  slideHtml: string[];
};

function extractNoteMarkdown(htmlValue: string): string | null {
  // Supports:
  // <!-- note: ... -->
  // <!-- note
  //   ...
  // -->
  const m = htmlValue.match(/^<!--\s*note(?::|\s)([\s\S]*?)-->$/i);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

function nodeLineRange(node: any): { startLine: number; endLine: number } {
  const startLine = node?.position?.start?.line ?? 1;
  const endLine = node?.position?.end?.line ?? startLine;
  return { startLine, endLine };
}

function isBlockNode(node: MdNode): boolean {
  if (!node || typeof node.type !== 'string') return false;
  return (
    node.type === 'heading' ||
    node.type === 'paragraph' ||
    node.type === 'list' ||
    node.type === 'code' ||
    node.type === 'blockquote' ||
    node.type === 'table' ||
    node.type === 'thematicBreak'
  );
}

function remarkNotesAndAnchors() {
  return (tree: MdRoot, file: any) => {
    const anchors: BlockAnchor[] = [];
    const notes: Note[] = [];

    const children: MdNode[] = Array.isArray(tree.children) ? tree.children : [];
    const newChildren: MdNode[] = [];

    let pendingNotes: { raw: string; markdown: string; range: { startLine: number; endLine: number } }[] = [];
    let noteOrder = 0;

    for (const child of children) {
      if (child?.type === 'html' && typeof child.value === 'string') {
        const noteMd = extractNoteMarkdown(child.value);
        if (noteMd != null) {
          pendingNotes.push({ raw: child.value, markdown: noteMd, range: nodeLineRange(child) });
          continue; // remove from body render
        }
      }

      if (isBlockNode(child) && child.type !== 'thematicBreak') {
        const anchorId = `a_${child.type}_${child.position?.start?.line ?? 1}_${nanoid(6)}`;
        child.data = child.data ?? {};
        child.data.hProperties = child.data.hProperties ?? {};
        child.data.hProperties['data-anchor'] = anchorId;

        anchors.push({
          anchorId,
          kind: child.type,
          sourceRange: nodeLineRange(child)
        });

        if (pendingNotes.length > 0) {
          for (const pn of pendingNotes) {
            notes.push({
              id: `n_${pn.range.startLine}_${noteOrder}_${nanoid(6)}`,
              anchorId,
              sourceRange: pn.range,
              raw: pn.raw,
              markdown: pn.markdown,
              order: noteOrder++
            });
          }
          pendingNotes = [];
        }
      }

      newChildren.push(child);
    }

    // If notes at EOF: attach to last anchor if available.
    if (pendingNotes.length > 0 && anchors.length > 0) {
      const anchorId = anchors[anchors.length - 1]!.anchorId;
      for (const pn of pendingNotes) {
        notes.push({
          id: `n_${pn.range.startLine}_${noteOrder}_${nanoid(6)}`,
          anchorId,
          sourceRange: pn.range,
          raw: pn.raw,
          markdown: pn.markdown,
          order: noteOrder++
        });
      }
    }

    tree.children = newChildren;
    file.data = file.data ?? {};
    file.data.mf = { anchors, notes };
  };
}

function computeSlides(markdown: string, anchors: BlockAnchor[], notes: Note[]): Slide[] {
  const lines = markdown.split('\n');
  const thematicBreakLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l === '---') thematicBreakLines.push(i + 1);
  }

  const startLines = new Set<number>();
  startLines.add(1);

  if (thematicBreakLines.length > 0) {
    for (const tb of thematicBreakLines) {
      if (tb < lines.length) startLines.add(tb + 1);
    }
  } else {
    // Fallback: use H1 starts only when there are no explicit slide separators.
    for (const a of anchors) {
      if (a.kind === 'heading') {
        const headingLine = a.sourceRange.startLine;
        const rawLine = lines[headingLine - 1] ?? '';
        if (rawLine.trimStart().startsWith('# ')) startLines.add(headingLine);
      }
    }
  }

  const sorted = [...startLines].filter((n) => n >= 1 && n <= lines.length).sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const slides: Slide[] = [];
  const anchorLineById = new Map<string, number>();
  for (const a of anchors) anchorLineById.set(a.anchorId, a.sourceRange.startLine);
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    let end = (sorted[i + 1] ? sorted[i + 1]! - 1 : lines.length) || lines.length;
    // Treat trailing `---` delimiter lines as separators, not slide content.
    while (end >= start && (lines[end - 1]?.trim() ?? '') === '---') end--;
    if (start > end) continue;
    const slideAnchors = anchors
      .filter((a) => a.sourceRange.startLine >= start && a.sourceRange.startLine <= end)
      .map((a) => a.anchorId);
    const slideNoteIds = notes
      .filter((n) => {
        const line = anchorLineById.get(n.anchorId) ?? 1;
        return line >= start && line <= end;
      })
      .map((n) => n.id);
    slides.push({
      id: `s_${start}_${end}_${nanoid(6)}`,
      sourceRange: { startLine: start, endLine: end },
      anchorIds: slideAnchors,
      noteIds: slideNoteIds
    });
  }
  return slides;
}

function sliceLines(markdown: string, startLine: number, endLine: number): string {
  const lines = markdown.split('\n');
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = Math.min(lines.length - 1, endLine - 1);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

export async function renderMarkdown(markdown: string): Promise<ParsedDoc> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkNotesAndAnchors)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeKatex)
    .use(rehypeHighlight, { languages: highlightLanguages, aliases: highlightAliases })
    .use(rehypeStringify);

  const file = await processor.process(markdown);
  const html = String(file);

  const mf = (file.data as any)?.mf ?? { anchors: [], notes: [] };
  const anchors: BlockAnchor[] = mf.anchors ?? [];
  const notes: Note[] = mf.notes ?? [];

  const slides = computeSlides(markdown, anchors, notes);
  const slideHtml: string[] = [];
  for (const s of slides) {
    const md = sliceLines(markdown, s.sourceRange.startLine, s.sourceRange.endLine);
    const sh = await processor.process(md);
    slideHtml.push(String(sh));
  }

  return { html, anchors, notes, slides, slideHtml };
}

export async function renderInlineMarkdown(markdown: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeKatex)
    .use(rehypeStringify);
  const file = await processor.process(markdown);
  return String(file);
}
