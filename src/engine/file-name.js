'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function sanitize(name) {
  let clean = String(name)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (!clean) clean = 'download';
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  // Keep room for the temporary-file suffix within the 255-character limit.
  if (clean.length > 200) {
    const ext = path.extname(clean).slice(0, 20);
    clean = clean.slice(0, 200 - ext.length) + ext;
  }
  return clean;
}

/** Reads the file name from Content-Disposition, preferring RFC 5987 filename*. */
function fromContentDisposition(header) {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim().replace(/^"|"$/g, ''));
    } catch {
      // Fall through to the plain parameter.
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  return plain ? plain[1].trim() : null;
}

function fromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

function chooseFileName({ contentDisposition, finalUrl, originalUrl, suggested }) {
  return sanitize(
    suggested || fromContentDisposition(contentDisposition) || fromUrl(finalUrl) || fromUrl(originalUrl) || 'download',
  );
}

/** Returns a path in dir that does not collide with existing or reserved files. */
function uniquePath(dir, name, isTaken = () => false) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate) && !fs.existsSync(candidate + '.mdpart') && !isTaken(candidate)) {
      return candidate;
    }
  }
}

module.exports = { sanitize, fromContentDisposition, chooseFileName, uniquePath };
