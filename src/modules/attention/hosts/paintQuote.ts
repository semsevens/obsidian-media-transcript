import { Annotation, isComment } from '../model';
import { isChrome } from './markdown/renderedText';
import { blocksOf, locateRun } from './locateRun';

/**
 * Wrap occurrences of a quote inside an already-rendered element.
 *
 * Shared by the hosts that paint over DOM someone else produced — reading mode
 * and the transcript panel. Both work on rendered text rather than offsets,
 * because in neither case does the DOM correspond character-for-character to
 * what the anchor was measured against.
 *
 * A quote is matched across the container's text as one string and then wrapped
 * piece by piece, so a mark running from plain text through a **bold** run and
 * out the other side is painted in full. Matching within single text nodes —
 * the obvious approach — silently skipped exactly those marks, which in a real
 * note is a great many of them.
 *
 * Idempotent: text already inside a highlight is skipped, so re-running after
 * the host rebuilds costs nothing and never nests.
 */
export function paintQuote(
  root: HTMLElement,
  annotation: Annotation,
  quote = annotation.anchor.quote,
  /**
   * Paint only the occurrence starting nearest this offset into `root`'s text,
   * rather than every one: a transcript line can repeat a phrase, and the
   * mark is on one of them.
   */
  near?: number,
): void {
  if (!quote) return;
  // The review panel renders quotes of its own; marking those would be marking
  // our own output.
  if (root.closest('.at-review')) return;

  // Offsets into the root's text count the text already painted, too.
  const nodes = textNodesIn(root, near !== undefined);
  if (nodes.length === 0) return;

  // One flat string, with each node's offset into it, so a quote spanning
  // several nodes is still just an indexOf.
  const starts: number[] = [];
  let full = '';
  for (const n of nodes) {
    starts.push(full.length);
    full += n.data;
  }

  // A quote spanning blocks cannot be found whole: the rendered text runs
  // paragraphs together while the stored quote keeps the blank lines. So it is
  // looked for a block at a time, each after the last.
  const blocks = blocksOf(quote);
  if (blocks.length === 0) return;

  const spans: { node: Text; from: number; to: number }[] = [];
  const cover = (at: number, end: number) => {
    for (let i = 0; i < nodes.length; i++) {
      const nodeStart = starts[i];
      const nodeEnd = nodeStart + nodes[i].data.length;
      if (nodeEnd <= at || nodeStart >= end) continue;
      spans.push({
        node: nodes[i],
        from: Math.max(at, nodeStart) - nodeStart,
        to: Math.min(end, nodeEnd) - nodeStart,
      });
    }
  };

  let closest: number[] | null = null;
  for (let from = 0; ; ) {
    const at = locateRun(full, blocks, from);
    if (!at) break;
    if (near === undefined) at.forEach((start, i) => cover(start, start + blocks[i].length));
    else if (!closest || Math.abs(at[0] - near) < Math.abs(closest[0] - near)) closest = at;
    from = at[at.length - 1] + blocks[blocks.length - 1].length;
  }
  closest?.forEach((start, i) => cover(start, start + blocks[i].length));
  // Never nest one mark in another.
  const free = spans.filter(sp => !isInsideHighlight(sp.node));
  spans.length = 0;
  spans.push(...free);

  // Back to front: wrapping splits nodes, which would invalidate the offsets
  // of anything still to its right.
  for (const s of spans.reverse()) wrap(s.node, s.from, s.to, annotation);
}

/**
 * Text nodes worth painting.
 *
 * Skips anything already inside a mark, and anything Obsidian drew rather than
 * the note — the properties table repeats what the frontmatter says, so a
 * phrase that is also a property value would otherwise be marked up there too,
 * in text the reader never wrote.
 */
function textNodesIn(root: HTMLElement, withPainted = false): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    if (text.data.length === 0) continue;
    if ((!withPainted && isInsideHighlight(text)) || isChrome(text)) continue;
    out.push(text);
  }
  return out;
}

function wrap(node: Text, from: number, to: number, annotation: Annotation): void {
  if (to <= from) return;
  const tail = from > 0 ? node.splitText(from) : node;
  if (to - from < tail.data.length) tail.splitText(to - from);

  const span = createSpan({ cls: isComment(annotation) ? 'at-hl at-hl-comment' : 'at-hl' });
  span.dataset.atId = annotation.id;
  tail.replaceWith(span);
  span.appendChild(tail);
}

/** Don't nest one highlight inside another when two annotations overlap. */
function isInsideHighlight(node: Node): boolean {
  return node.parentElement?.closest('.at-hl') != null;
}
