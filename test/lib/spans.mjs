import { KIND_MAP } from './kind-map.mjs';

const trivia = new Set(['line_comment', 'block_comment', 'shebang']);
const ownsTrivia = new Set(['Markup', 'Code']);

// Index parents and direct non-trivia children in one preorder pass. Equal
// spans are common for nested Math nodes, so offsets cannot establish ancestry.
function indexTree(nodes) {
  const stack = [];
  for (const node of nodes) {
    if (!Number.isInteger(node.depth) || node.depth > stack.length) {
      throw new Error('missing or invalid tree depth (rebuild the oracle)');
    }
    stack.length = node.depth;
    node.parent = stack.at(-1);
    if (node.parent) {
      node.parent.first ??= node;
      node.parent.last = node;
    }
    stack.push(node);
  }
  return nodes;
}

function expectedNodes(records) {
  const result = [];
  for (const node of indexTree(records.map(([start, end, kind, depth]) => ({ start, end, kind, depth })))) {
    const { kind, parent, start, end } = node;
    let name = KIND_MAP[kind];
    if (kind === 'Markup') name = parent ? 'markup' : 'source_file';
    // Emphasis delimiters and math subscripts are anonymous. Patterns name their underscore.
    if (kind === 'Underscore' && !['MathAttach', 'Emph'].includes(parent?.kind)) name = 'underscore';
    // The raw body is a single opaque token in the grammar. Typst splits it
    // into Text and RawTrimmed leaves during dedentation.
    if (parent?.kind === 'Raw' && kind === 'Text') continue;
    if (!name || (parent && (start === end || (ownsTrivia.has(kind) && !node.first)))) continue;
    node.name = name;
    result.push(node);
  }
  return result;
}

/** Compare mapped node occurrences, their byte spans and their parents in both directions. */
export function compareSpans(theirs, mine, buf) {
  const candidates = new Map();
  const nodes = indexTree(mine.map(node => ({ ...node }))).filter(node =>
    !trivia.has(node.kind) && !(node.kind === 'raw_content' && node.parent?.kind === 'raw'));
  for (const node of nodes) {
    if (!node.parent && node.kind === 'source_file') {
      node.start = 0;
      node.end = buf.length;
    }
    const key = [node.kind, node.start, node.end].join(':');
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(node);
  }

  const differences = [];
  for (const node of expectedNodes(theirs)) {
    const find = (s, e) => candidates.get([node.name, s, e].join(':'))?.find(n => !n.used);
    let match = find(node.start, node.end);
    // Tree-sitter may leave the leading and trailing trivia outside a container.
    if (!match && ownsTrivia.has(node.kind) && node.first) match = find(node.first.start, node.last.end);
    const where = ' at ' + node.start + '..' + node.end;
    if (!match) {
      differences.push(node.name + where + ' missing');
      continue;
    }
    match.used = true;
    node.match = match;
    if (node.parent?.match && node.parent.match !== match.parent) {
      differences.push(node.name + where + ' has a different parent');
    }
  }
  for (const { used, kind, start, end } of nodes) {
    if (!used) differences.push(kind + ' at ' + start + '..' + end + ' extra');
  }
  return differences;
}
