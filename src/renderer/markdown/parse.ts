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
import { visit } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';

const solidity = (solidityPackage as { solidity?: unknown }).solidity;

const highlightLanguages = solidity
  ? { ...common, solidity: solidity as typeof common[string] }
  : common;

const highlightAliases = {
  sol: 'solidity'
};

const MARKFLOW_ASSET_PROTOCOL = 'markflow-asset';

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

type FrontmatterExtraction = {
  content: string;
  lineOffset: number;
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

export function extractLeadingYamlFrontmatter(markdown: string): FrontmatterExtraction {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { content: markdown, lineOffset: 0 };

  const frontmatter = match[1] ?? '';

  try {
    const parsed = parseYaml(frontmatter);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { content: markdown, lineOffset: 0 };
    }

    const consumedLines = match[0].replace(/\r?\n$/, '').split(/\r?\n/).length;
    return { content: markdown.slice(match[0].length), lineOffset: consumedLines };
  } catch {
    return { content: markdown, lineOffset: 0 };
  }
}

function toMarkdownAssetUrl(path: string): string {
  return `${MARKFLOW_ASSET_PROTOCOL}://asset?path=${encodeURIComponent(path.replace(/\\/g, '/'))}`;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function isAbsoluteFilesystemPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || isWindowsAbsolutePath(value);
}

function shouldLeaveImageUrlUnchanged(url: string): boolean {
  return url.startsWith('#') || url.startsWith('//') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
}

function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? normalized : normalized.slice(0, idx);
}

function joinRelativePath(baseDir: string, relativePath: string): string {
  const baseParts = baseDir.replace(/\\/g, '/').split('/');
  const relParts = relativePath.replace(/\\/g, '/').split('/');
  const parts = [...baseParts];

  for (const part of relParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(part);
  }

  if (baseDir.startsWith('/')) return `/${parts.filter((part, index) => !(index === 0 && part === '')).join('/')}`;
  return parts.join('/');
}

export function resolveMarkdownImageUrl(url: string, docPath: string | null | undefined): string {
  const trimmed = url.trim();
  if (!trimmed || shouldLeaveImageUrlUnchanged(trimmed)) return url;
  if (isAbsoluteFilesystemPath(trimmed)) return toMarkdownAssetUrl(trimmed);
  if (!docPath) return url;

  return toMarkdownAssetUrl(joinRelativePath(dirname(docPath), trimmed));
}

function remarkImages(options?: { docPath?: string | null }) {
  return (tree: MdRoot) => {
    if (!options?.docPath) return;

    visit(tree, 'image', (node: MdNode) => {
      if (typeof node?.url !== 'string') return;
      node.url = resolveMarkdownImageUrl(node.url, options.docPath);
    });
  };
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
        const range = nodeLineRange(child);
        const anchorId = `a_${child.type}_${child.position?.start?.line ?? 1}_${nanoid(6)}`;
        child.data = child.data ?? {};
        child.data.hProperties = child.data.hProperties ?? {};
        child.data.hProperties['data-anchor'] = anchorId;
        child.data.hProperties['data-source-start-line'] = String(range.startLine);
        child.data.hProperties['data-source-end-line'] = String(range.endLine);

        anchors.push({
          anchorId,
          kind: child.type,
          sourceRange: range
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

export async function renderMarkdown(markdown: string, options?: { docPath?: string | null }): Promise<ParsedDoc> {
  const frontmatter = extractLeadingYamlFrontmatter(markdown);
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkImages, {
      docPath: options?.docPath
    })
    .use(remarkNotesAndAnchors)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeKatex)
    .use(rehypeHighlight, { languages: highlightLanguages, aliases: highlightAliases })
    .use(rehypeStringify);

  const file = await processor.process(frontmatter.content);
  const html = String(file);

  const mf = (file.data as any)?.mf ?? { anchors: [], notes: [] };
  const shiftRange = (range: { startLine: number; endLine: number }) => ({
    startLine: range.startLine + frontmatter.lineOffset,
    endLine: range.endLine + frontmatter.lineOffset
  });
  const anchors: BlockAnchor[] = (mf.anchors ?? []).map((anchor: BlockAnchor) => ({
    ...anchor,
    sourceRange: shiftRange(anchor.sourceRange)
  }));
  const notes: Note[] = (mf.notes ?? []).map((note: Note) => ({
    ...note,
    sourceRange: shiftRange(note.sourceRange)
  }));

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
