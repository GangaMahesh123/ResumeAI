'use strict';
// Headless LibreOffice rendering: DOCX → PDF page count, and DOC → DOCX conversion.
// Uses a per-call profile directory so concurrent requests don't collide.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

let _available = null;

function run(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(config.sofficePath, args, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }));
      resolve(String(stdout || ''));
    });
  });
}

async function isAvailable() {
  if (_available !== null) return _available;
  try { await run(['--version'], 30000); _available = true; } catch { _available = false; }
  return _available;
}

async function convert(buffer, inExt, outFormat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resumeai-'));
  const profile = path.join(os.tmpdir(), `lo-profile-${crypto.randomBytes(6).toString('hex')}`);
  const inFile = path.join(dir, `input${inExt}`);
  try {
    fs.writeFileSync(inFile, buffer);
    await run([`-env:UserInstallation=file://${profile}`, '--headless', '--norestore', '--convert-to', outFormat, '--outdir', dir, inFile], config.renderTimeoutMs);
    const outExt = outFormat.split(':')[0];
    const outFile = path.join(dir, `input.${outExt}`);
    if (!fs.existsSync(outFile)) throw new Error('LibreOffice produced no output file');
    return fs.readFileSync(outFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** Render a DOCX and count its pages. Returns { pages, verified, error }. */
async function countPages(docxBuffer) {
  if (!(await isAvailable())) return { pages: null, verified: false, error: 'LibreOffice is not installed on the server, so the page count could not be verified.' };
  try {
    const pdf = await convert(docxBuffer, '.docx', 'pdf');
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(pdf);
    return { pages: data.numpages, verified: true, error: null };
  } catch (e) {
    return { pages: null, verified: false, error: `Page rendering failed: ${e.message}` };
  }
}

async function docToDocx(buffer) {
  if (!(await isAvailable())) throw Object.assign(new Error('.doc files need LibreOffice on the server to convert. Please upload a .docx instead.'), { code: 'UNSUPPORTED_FORMAT' });
  return convert(buffer, '.doc', 'docx:"MS Word 2007 XML"');
}

module.exports = { countPages, docToDocx, isAvailable };
