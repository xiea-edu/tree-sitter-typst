import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TS_BIN } from './lib/harness.mjs';

// A fresh directory and Emacs process prevent an installed grammar from satisfying the tests.
const tmp = path.join(ROOT, '.tmp');
fs.mkdirSync(tmp, { recursive: true });
const dir = fs.mkdtempSync(path.join(tmp, 'emacs-'));
try {
  const ext = { win32: 'dll', darwin: 'dylib' }[process.platform] ?? 'so';
  execFileSync(TS_BIN, ['build', '-o', path.join(dir, 'libtree-sitter-typst.' + ext)], {
    cwd: ROOT, stdio: 'inherit',
  });
  const args = ['-Q', '--batch'];
  if (process.env.TYPST_TS_MODE_DIR) args.push('-L', process.env.TYPST_TS_MODE_DIR);
  // These options choose different queries when the major mode is first loaded.
  const alternatives = ['--eval', '(setq typst-ts-markup-header-same-height nil typst-ts-enable-raw-blocks-highlight t)'];
  for (const options of [[], alternatives]) {
    execFileSync(process.env.EMACS ?? 'emacs', [...args, ...options, '-l', 'test/emacs.el', '-f', 'ert-run-tests-batch-and-exit'], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, TYPST_TEST_GRAMMAR: dir },
    });
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
