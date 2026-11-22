import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  ROOT, TS_BIN, decodeSpanBatch, oracleParseText, parseSexpNodes, spanTrees, tsParseSexp,
} from './lib/harness.mjs';
import { compareSpans } from './lib/spans.mjs';

const dir = fs.mkdtempSync(path.join(ROOT, '.tmp', 'regressions-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(name, source) {
  const file = path.join(dir, name + '.typ');
  fs.writeFileSync(file, source);
  return file;
}

function check(source, ok = true) {
  const oracle = oracleParseText(source);
  assert.equal(oracle.ok, ok, source);
  const tree = tsParseSexp(fixture('case', source));
  assert.match(tree, /^\(source_file /);
  assert.equal(!/\((?:ERROR|MISSING)\b/.test(tree), ok, source);
  if (ok) {
    const buf = Buffer.from(source);
    assert.deepEqual(compareSpans(oracle.nodes, parseSexpNodes(tree, buf), buf), [], source);
  }
  return tree;
}

test('blank lines keep indented list bodies and close before dedented content', () => {
  for (const s of [
    '- parent\n\n  child', '- parent\n\n  - nested\n\n    body\n\n- sibling',
    '+ parent\n \n\n  child\noutside', '/ term: first\n\n  second', '- last\n\n',
  ]) check(s);
});

test('line-start context survives comments and restarts inside item bodies', () => {
  for (const s of [
    'text\n/**/ = Heading', 'text /**/ = ordinary', 'text /*\n*/ = ordinary',
    '1. 1. nested\n   2. sibling\n2. outer', '/ term: - nested', 'intro\n/ term: - nested',
    '- parent\n /**/- child\n/**/ - sibling\noutside', '-\n /**/- first',
    '- a\n  /path', '- a\n  / term: body', '#[\n  // before first\n  - item\n]',
    '*text\n/**/ = Heading\n*', 'text\n/**/ 123abc',
    '- one\n /* outer /* nested */\n  */ - two\n- three',
  ]) check(s);
  const tree = check('- parent\n' + '  /* item comment */\n'.repeat(64) + '  body');
  assert.equal(tree.match(/\(block_comment\b/g)?.length, 64);
});

test('literal brackets and word punctuation preserve markup text boundaries', () => {
  for (const s of [
    '#[[#name]]', 'a ["b" [$x$]] c', 'abc_def*g 0.1_g', 'a..b...c', 'abc httpish',
    'a< b', 'https:\\/\\/example', '-٣ -¾', '_#name._', '#a._ b _', '#a._field',
  ]) check(s);
  check('0._x', false);
});

test('only complete HTTP schemes interrupt a markup text run', () => {
  for (const scheme of ['http', 'https']) {
    for (const tail of [':', ':x', ':/x', ':\\/\\/example', '://example.org']) {
      check('prefix ' + scheme + tail);
    }
  }
  check('/ see https: definition');
  check('αhttp:/x https://example.org http:');
});

test('postfix math and trailing code comments preserve the oracle tree', () => {
  for (const s of [
    "$n'!'$", "$n!'!$", "$a_n'!'^b$", '$==> =>> <==>$',
    '$pi.alt(x) pi.alt/**/(x) pi.alt / x$', '#{1 /* tail */}', '#{1 /* inside */ + 2}',
  ]) check(s);
});

test('a shebang is trivia only at the start of the document', () => {
  assert.match(check('#!/usr/bin/env typst\n= Title\n\nHello'), /\(shebang \[0, 0\]/);
  check('#!');
  for (const prefix of [' ', '\n', '/*comment*/', '//comment\n', 'text\n']) check(prefix + '#!/bin', false);
});

test('markup markers recognize Unicode whitespace and actual comment openers', () => {
  for (const s of ['=/usr/local', '-/path', '+/path', '1./path', '/path', '=\u00a0Title',
    '-\u2003item', '+\u3000item', '1.\u00a0item', '=//note\ntext', '=/*one*/ /*two*/ Title']) check(s);
  assert.match(check('-/*one /*two*/ */item'), /\(block_comment\b/);
  assert.match(check('+//note\n  item'), /\(line_comment\b/);
});

test('not in accepts trivia according to the surrounding newline mode', () => {
  for (const gap of [' ', '   ', '\t', '\u00a0', ' /*a /*b*/ c*/ ', '/*a\nb*/']) {
    check('#{x not' + gap + 'in xs}');
    check('#let y = x not' + gap + 'in xs');
  }
  for (const gap of ['\n', ' // line\n']) {
    check('#{x not' + gap + 'in xs}', false);
    check('#{(x not' + gap + 'in xs)}');
  }
  check('#{not x}');
  check('#{x not in-foo}', false);
});

test('named functions need adjacent parameters and a body; commas require an item', () => {
  for (const s of ['#let x', '#let f() = 1', '#let f(x,) = x', '#let f\n(x) = x',
    '#let f = (x,) => x', '#f()', '#f(x,)', '$sqrt(,x,;y)$']) check(s);
  for (const s of ['#let f(x)', '#let f (x) = x', '#let f/*c*/(x) = x', '#let f(x) =',
    '#foo(,)', '#let f(,) = 1', '#let f = (,) => 1']) check(s, false);
});

test('bindings, assignments, and argument sinks have different pattern syntax', () => {
  for (const s of ['#let let_ = 1', '#let x', '#let (a, .., b) = v',
    '#let f((..inner), ..rest) = rest', '#((target.at(0),) = source)',
    '#{ () = value }', '#(false.true)', '#(let (x)\n=1)']) check(s);
  for (const s of ['#let as = 1', '#let (context, b) = v', '#let (x)', '#let _',
    '#let f(none: 0) = x', '#let f(..true) = x', '#let f(..a, ..b) = x',
    '#let (..a, ..b) = v', '#let (target.at(0),) = v', '#let (x: target.field) = v',
    '#(:..)', '#f(..)']) check(s, false);
});

test('embedded code, blocks, and parentheses apply their own newline rules', () => {
  for (const s of ['#let x = (1 +\n 2)', '#(if c\n [body])', '#{if c\n .name [body]}',
    '#let /*\n*/ x = 1', '#context let x = 1', '#context (-x)',
    '$#if true [] /* a */ else /* b */ []$', '#(a\n: 1)']) check(s);
  for (const s of ['# value', '#/*c*/value', '#let\n x = 1', '#let x =\r\n 2',
    '#let x =\n/*c*/ 1', '#return f(x) +\n next', '#if c\n .name [body]',
    '#if c\n /*c*/ [body]', '#{if c\n[body]}', '#context +x',
    '#{f/*c*/(x)}', '#{f/*c*/[x]}', '#(f\n(x))', '#value._']) check(s, false);
});

test('markup boundaries survive nested scopes and numbered marker overflow', () => {
  for (const s of ['= x < y', '= [x\nnext', '- [a\n b]', '- a\n  - b *\n - c\n *\n  - d',
    '18446744073709551615. item', '18446744073709551616. prose', '00000000000000000001. item',
    'https://[)', '@r\n[s]', '@r/*c*/[s]', '$a\n!$', '$a\n(x)$', '$a\\\u00a0b$']) check(s);
  for (const s of ['= [\na]', '- [a\na]', '\n$x^$\n']) check(s, false);
});

test('radix integers use the signed 64-bit limit independently of token length', () => {
  for (const [base, prefix] of [[2, '0b'], [8, '0o'], [16, '0x']]) {
    const maximum = (1n << 63n) - 1n;
    for (const padding of ['', '0'.repeat(75)]) {
      check('#let x = ' + prefix + padding + maximum.toString(base));
      check('#let x = ' + prefix + padding + (maximum + 1n).toString(base), false);
    }
  }
  check('#let x = ' + '9'.repeat(85));
  check('#let x = ' + '0'.repeat(80) + '1.5em');
  for (const number of ['0b2', '0o8', '0x', '0x12pt', '2e+']) check('#let x = ' + number, false);
});

test('math graphemes, identifiers, fields and argument wrappers match the oracle', () => {
  for (const s of [
    '$e\u0301 e\u0301(x) e\u0301x(x) ab.e\u0301$',
    '$👩‍💻 👩🏽‍💻 🇺🇸🇨🇦 क्‍ष 각(x) Ⅳ(x) \u0345(x) १२.३$',
    '$sqrt(e\u0301-name: x, e\u0301-name, a := b, tag : x)$',
    '$sqrt(.., .. x, ..args, ...)$', '$sqrt(x)$', '$sqrt(a b, name: #12pt, ..args)$', '$sqrt(f(x), g(a b))$',
    '$[f(e\u0301)$', '$[f(e\u0301)]$',
  ]) check(s);
});

test('import locals capture the name bound by each import', () => {
  const src = '#import "a.typ" as mod: a.b as c, d.e, f';
  check(src);
  const out = execFileSync(TS_BIN, ['query', '--captures', 'queries/locals.scm', fixture('imports', src)], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const captures = [...out.matchAll(/local\.definition\.import, start: \(0, (\d+)\), end: \(0, (\d+)\)/g)];
  assert.deepEqual(captures.map(m => src.slice(+m[1], +m[2])), ['mod', 'c', 'e', 'f']);
});

test('span comparison catches extra, duplicate, missing and misplaced nodes', () => {
  const source = '$sqrt(x)$';
  const oracle = oracleParseText(source).nodes;
  const buf = Buffer.from(source);
  const nodes = parseSexpNodes(tsParseSexp(fixture('spans', source)), buf);
  const compare = ns => compareSpans(oracle, ns, buf);
  const leaf = nodes.at(-1);
  assert.deepEqual(compare(nodes), []);
  assert.match(compare(nodes.slice(0, -1)).join(), /math_text .* missing/);
  assert.match(compare([...nodes, leaf]).join(), /math_text .* extra/);
  assert.match(compare([...nodes.slice(0, -1), { ...leaf, kind: 'math' },
    { ...leaf, depth: leaf.depth + 1 }]).join(), /math .* extra/);
  assert.match(compare([...nodes.slice(0, -1), { ...leaf, depth: leaf.depth - 1 }]).join(), /different parent/);
});

test('batched trees agree with single parses; invalid batch output cannot shift file attribution', () => {
  const files = ['= α\n\n$x$', ' \n ', '#let f(x) = x'].map((s, i) => fixture('batch α ' + i, s));
  const batch = [...spanTrees(files)];
  assert.deepEqual(batch, files.map(f => [f, tsParseSexp(f).trim()]));
  const [file, tree] = batch[0];
  const footer = '\n' + file + '\tParse: 0.1 ms\n';
  for (const output of ['', tree + footer + 'partial', tree.slice(0, -1) + footer, tree + footer + tree + footer]) {
    assert.throws(() => decodeSpanBatch(output, [file]));
  }
  assert.throws(() => decodeSpanBatch(tree + footer, [files[1]]));
  const split = [...spanTrees(files, group => {
    if (group.length > 1) throw new Error('batch too large');
    return new Map([[group[0], tsParseSexp(group[0]).trim()]]);
  })];
  assert.deepEqual(split, batch);
  assert.throws(() => [...spanTrees([file], () => { throw new Error('timeout'); })], err =>
    err.message.includes(file) && err.cause.message === 'timeout');
});

test('incremental edits across scanner lookahead boundaries match fresh oracle-checked trees', () => {
  for (const [before, needle, replacement, valid = true] of [
    ['#let x = 1', '= ', '=\n/*c*/', false], ['#foo', '#', '# ', false],
    ['#let f(..a, b) = a', ', b', ', ..b', false], ['#let (x)', '(x)', 'x'],
    ['#(f\n(x))', '\n', ''], ['@r[s]', '[', '/*c*/['],
    ['- [a\n b]', ' b', 'b', false], ['18446744073709551615. x', '15.', '16.'],
    ['a_b_', 'a', '.'], ['a _x_', ' _x_', '_x'], ['a..b', '..', '...'],
    ['prefix https:/x', ':/', '://'], ['prefix http://x', '//', '\\/\\/'],
    ['- outer\n /**/- child', '/**/', ''], ['text\n/**/ = H', '\n', ' '],
    ["$n'!$", '!', "!'"], ['$pi.alt(x)$', '(', '/**/('],
    ['#[outer [#x]]', '#x', 'inner [x]'],
    ['#{1 /*tail*/}', '}', ' + 2}'],
    ['- parent\n\nchild', 'child', '  child'],
    ['= /path', ' ', ''],
    ['#!/bin\n= Title', '#!', ''],
    ['$e(x)$', 'e', 'e\u0301'],
    ['$sqrt(x y)$', ' y', ''],
    ['$sqrt(e\u0301-name)$', '-name', '-name: x'],
    ['#let x = 0x8000000000000000', '8', '7'],
    ['#let f (x) = x', 'f ', 'f'],
    ['#{x notin xs}', 'notin', 'not  in'],
  ]) {
    const at = before.indexOf(needle);
    assert.notEqual(at, -1);
    const after = before.slice(0, at) + replacement + before.slice(at + needle.length);
    const offset = Buffer.byteLength(before.slice(0, at));
    const edit = [offset, Buffer.byteLength(needle), replacement].join(' ');
    const tree = tsParseSexp(fixture('before', before), ['--edits', edit]);
    // The CLI adds a path and timing footer to erroneous parses.
    const syntax = output => output.split(/\r?\n(?=[^\n]+\tParse:)/)[0].trim();
    assert.equal(syntax(tree), syntax(check(after, valid)), after);
  }
});
