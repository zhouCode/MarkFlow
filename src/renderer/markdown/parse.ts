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

export type ParsedDoc = {
  html: string;
  anchors: BlockAnchor[];
  notes: Note[];
};

function extractNoteMarkdown(htmlValue: string): string | null {
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
          continue;
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

  return { html, anchors, notes };
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
