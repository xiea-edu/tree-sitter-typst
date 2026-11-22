/**
 * Minimal tar reader.
 *
 * We extract `.typ` files out of gzipped tarballs (the Typst source tree and Typst
 * Universe packages). Node ships gzip via `zlib` but has no tar support, and shelling
 * out to `tar` is not portable across Windows installations. Tar is a simple enough format
 * that reading it here beats taking a dependency.
 *
 * Handles the ustar `prefix` field plus GNU long names and pax extended headers, all
 * of which appear in GitHub-generated tarballs with deep paths.
 */

import zlib from 'node:zlib';

const BLOCK = 512;

/** Read a NUL-terminated string out of a header field. */
function str(buf, offset, size) {
  const slice = buf.subarray(offset, offset + size);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** Tar stores numbers as NUL/space-terminated octal. */
function octal(buf, offset, size) {
  const s = str(buf, offset, size).trim();
  return s === '' ? 0 : parseInt(s, 8);
}

/**
 * Iterate the entries of a gzipped tarball.
 *
 * @param {Buffer} gz gzipped tar data
 * @yields {{name: string, data: Buffer}} regular files only
 */
export function* readTarGz(gz) {
  const buf = zlib.gunzipSync(gz);
  let pos = 0;
  // Set by an immediately preceding GNU-longname or pax header entry.
  let pendingName = null;

  while (pos + BLOCK <= buf.length) {
    const header = buf.subarray(pos, pos + BLOCK);

    // Two consecutive zero blocks mark end of archive; one is enough to stop on.
    if (header.every((b) => b === 0)) break;

    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]);
    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    // Entry data is padded out to a block boundary.
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') {
      // GNU long name: the full path is this entry's body, applying to the next entry.
      pendingName = buf.subarray(dataStart, dataEnd).toString('utf8').replace(/\0+$/, '');
      continue;
    }

    if (type === 'x' || type === 'g') {
      // pax extended header: "<len> path=<value>\n" records.
      const text = buf.subarray(dataStart, dataEnd).toString('utf8');
      const m = text.match(/\d+ path=([^\n]*)\n/);
      if (m) pendingName = m[1];
      continue;
    }

    let name = pendingName;
    pendingName = null;
    if (name === null) {
      const prefix = str(header, 345, 155);
      const base = str(header, 0, 100);
      name = prefix ? `${prefix}/${base}` : base;
    }

    // '0' and '\0' are regular files; everything else (dirs, links, etc.) we skip.
    if (type === '0' || type === '\0') {
      yield { name, data: buf.subarray(dataStart, dataEnd) };
    }
  }
}
