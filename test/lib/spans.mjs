import { KIND_MAP } from './kind-map.mjs';

const trivia = new Set(['comment', 'shebang']);
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
      if (node.parent.last) node.parent.last.next = node;
      (node.parent.children ??= []).push(node);
      node.parent.first ??= node;
      node.parent.last = node;
    }
    stack.push(node);
  }
  return nodes;
}

const binaryOperators = {
  Plus: 'add', Minus: 'sub', Star: 'mul', Slash: 'div', And: 'and', Or: 'or',
  In: 'in', Not: 'in', Lt: 'cmp', Gt: 'cmp', LtEq: 'cmp', GtEq: 'cmp', EqEq: 'cmp',
  ExclEq: 'cmp', Eq: 'assign', PlusEq: 'assign', HyphEq: 'assign', StarEq: 'assign', SlashEq: 'assign',
};

function expectedNodes(records, buf) {
  const tree = indexTree(records.map(([start, end, kind, depth]) => ({ start, end, kind, depth })));
  const result = [];
  const text = node => buf.toString('utf8', node.start, node.end);
  for (const node of tree) {
    const { kind, parent, start, end } = node;
    let name = KIND_MAP[kind];
    if (kind === 'Markup') name = parent ? null : 'source_file';
    if (kind === 'Underscore' && !['MathAttach', 'Emph'].includes(parent?.kind)) name = 'wildcard';
    if (kind === 'Hash') {
      // The mode encloses the hash, expression and optional terminator in code.
      // A separated semicolon in math arguments starts the next row.
      const expression = node.next;
      const terminator = expression.next;
      const terminated = terminator?.kind === 'Semicolon' &&
        (parent.kind !== 'MathArgs' || expression.end === terminator.start);
      const code = { name: 'code', start, end: terminated ? terminator.end : expression.end, parent };
      expression.parent = code;
      result.push(code);
    }
    if (kind === 'Raw') {
      name = node.first.end - node.first.start >= 3 ? 'raw_blck' : 'raw_span';
      const bodyStart = node.children.find(child => child.kind === 'RawLang')?.end ?? node.first.end;
      if (bodyStart < node.last.start) {
        node.blob = { name: 'blob', start: bodyStart, end: node.last.start, parent: node };
      }
    }
    if (parent?.kind === 'Raw' && kind === 'Text') continue;
    if (kind === 'Math') {
      // A factorial is a two-child Math with an adjacent exclamation mark. A
      // surrounding math sequence (e.g. the contents of an equation) remains a formula.
      name = node.children?.length === 2 && node.last.kind === 'MathText' &&
        text(node.last) === '!' && node.first.end === node.last.start ? 'fac' : 'formula';
    }
    if (kind === 'MathText') {
      if (parent.name === 'fac' && parent.last === node) continue;
      name = /^\p{Alphabetic}+$/u.test(text(node)) ? 'letter' : 'symbol';
    }
    if (kind === 'Star' && parent?.kind === 'ModuleImport') name = 'wildcard';
    if (kind === 'As' && parent?.kind === 'ModuleImport') {
      const ident = node.next;
      const alias = { name: 'as', start, end: ident.end, parent };
      ident.parent = alias;
      result.push(alias);
    }
    if (kind === 'SetRule') {
      const [, target, args] = node.children;
      node.targetCall = { name: 'call', start: target.start, end: args.end, parent: node };
      target.parent = args.parent = node.targetCall;
    }
    if (kind === 'Unary') name = node.first.kind === 'Not' ? 'not' : 'sign';
    if (kind === 'Binary') name = binaryOperators[node.children[1].kind];
    if (kind === 'Closure' && parent?.kind === 'LetBinding' && node.first.kind === 'Ident') {
      // The mode puts only f(params) in the call. The body is a sibling under let.
      const params = node.children[1];
      node.end = params.end;
      params.signature = true;
      node.last.parent = parent;
      name = 'call';
    }
    if (node.signature) name = 'group';
    if (!name || (parent && start === end)) continue;
    node.name = name;
    result.push(node);
    if (kind === 'Numeric') {
      const suffix = text(node).match(/[a-z]+$|%$/)[0];
      result.push({ name: 'unit', start: end - suffix.length, end, parent: node });
    }
    if (node.blob) result.push(node.blob);
    if (node.targetCall) result.push(node.targetCall);
  }
  return result;
}

function editorNodes(records) {
  const nodes = indexTree(records.map(node => ({ ...node })));
  // Outline containers group multiple compiler siblings. Their fold and edit
  // boundaries are checked in Emacs. Compare each contained expression to Typst.
  return nodes.filter(node => {
    const outer = node.parent;
    // A statement terminator can put trailing comment extras inside code.
    // The oracle elides trivia, so compare up to the last expression in that case.
    if (node.kind === 'code' && node.last?.kind === 'comment' && node.last.end === node.end) {
      node.end = node.children.findLast(child => child.kind !== 'comment').end;
    }
    node.editorOnly = node.kind === 'section' ||
      (node.kind === 'content' && outer?.kind === 'section');
    while (node.parent?.editorOnly) node.parent = node.parent.parent;
    return !node.editorOnly && !trivia.has(node.kind);
  });
}

/** Compare mapped node occurrences, their byte spans and their parents in both directions. */
export function compareSpans(theirs, mine, buf) {
  const candidates = new Map();
  const nodes = editorNodes(mine);
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
  for (const node of expectedNodes(theirs, buf)) {
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
    let parent = node.parent;
    while (parent && !parent.name) parent = parent.parent;
    if (parent?.match && parent.match !== match.parent) {
      differences.push(node.name + where + ' has a different parent');
    }
  }
  for (const { used, kind, start, end } of nodes) {
    if (!used) differences.push(kind + ' at ' + start + '..' + end + ' extra');
  }
  return differences;
}
