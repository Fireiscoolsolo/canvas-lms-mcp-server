// Turns Canvas course files (PDF, Word, PowerPoint and plain text) into text the assistant can read.
// Pure functions over the downloaded bytes, so they can be unit tested without Canvas.
// The PDF and Office readers are large, so they load the first time a file needs them, not at server start.
const loadZip = async () => (await import('jszip')).default;
const loadPdf = () => import('unpdf');

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
// How much text an Office file may expand to. A real deck or document is far smaller; a crafted 250 KB file can expand
// to gigabytes and take the server down with it.
export const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;

const tooBig = (max) => new Error(`This file expands to more than ${Math.round(max / 1048576)} MB of text inside, which is too big to read here. Use download_file to save it instead.`);

/**
 * One file inside an Office archive as text, counting what it expands to as it goes. The size the archive claims is
 * checked first, but a crafted archive can lie about it, so inflating stops as soon as the real bytes pass the budget.
 */
function readEntry(zip, name, budget) {
  const entry = zip.file(name);
  if (!entry) return Promise.resolve(null);
  if (Number(entry._data?.uncompressedSize) > budget.left) return Promise.reject(tooBig(budget.max));
  return new Promise((resolve, reject) => {
    const parts = [];
    let done = false;
    const stream = entry.internalStream('uint8array');
    stream
      .on('data', (chunk) => {
        if (done) return;
        budget.left -= chunk.length;
        if (budget.left < 0) { done = true; stream.pause(); reject(tooBig(budget.max)); return; }
        parts.push(chunk);
      })
      .on('error', (e) => { if (!done) { done = true; reject(e); } })
      .on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts).toString('utf8')); } })
      .resume();
  });
}

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'xml', 'tex', 'py', 'js', 'ts', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'go', 'r', 'sql', 'm']);

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

/** Which reader a file needs, from its name and content type. Null when it can't be read. */
export function kindOf(name, contentType) {
  const ext = ((String(name || '').match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (ext === 'pdf' || ct.includes('application/pdf')) return 'pdf';
  if (ext === 'docx' || ct.includes('wordprocessingml')) return 'docx';
  if (ext === 'pptx' || ct.includes('presentationml')) return 'pptx';
  if (ext === 'html' || ext === 'htm' || ct.includes('text/html')) return 'html';
  if (TEXT_EXTENSIONS.has(ext) || ct.startsWith('text/')) return 'text';
  return null;
}

/** Text from Office XML: runs (<w:t> or <a:t>) joined per paragraph (<w:p> or <a:p>), one paragraph per line. */
export function officeXmlText(xml, runTag, paraTag) {
  const run = new RegExp(`<${runTag}(?:\\s[^>]*)?>([^<]*)</${runTag}>`, 'g');
  return String(xml)
    .split(`</${paraTag}>`)
    .map((p) => [...p.matchAll(run)].map((m) => decodeXml(m[1])).join(''))
    .filter((line) => line.trim())
    .join('\n');
}

async function docxText(buf, budget) {
  const zip = await (await loadZip()).loadAsync(buf);
  const xml = await readEntry(zip, 'word/document.xml', budget);
  if (!xml) throw new Error("This Word file doesn't contain a readable document.");
  return officeXmlText(xml, 'w:t', 'w:p');
}

const slideNumber = (name) => Number((name.match(/(\d+)\.xml$/) || [])[1] || 0);

async function pptxText(buf, budget) {
  const zip = await (await loadZip()).loadAsync(buf);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNumber(a) - slideNumber(b));
  const out = [];
  for (const [i, name] of slides.entries()) {
    const text = officeXmlText(await readEntry(zip, name, budget), 'a:t', 'a:p');
    // Speaker notes are linked from the slide's relationships file, not numbered the same way.
    const rels = await readEntry(zip, name.replace('slides/', 'slides/_rels/') + '.rels', budget);
    const notesTarget = rels && (rels.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/) || [])[1];
    const notesXml = notesTarget && await readEntry(zip, `ppt/notesSlides/${notesTarget}`, budget);
    const notes = notesXml ? officeXmlText(notesXml, 'a:t', 'a:p').replace(/^\d+$/m, '').trim() : '';
    out.push(`--- Slide ${i + 1} ---\n${text || '(no text on this slide)'}${notes ? `\nSpeaker notes: ${notes}` : ''}`);
  }
  return out.join('\n\n');
}

async function pdfText(buf) {
  const { extractText, getDocumentProxy } = await loadPdf();
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((t, i) => `--- Page ${i + 1} ---\n${String(t).trim()}`).join('\n\n');
}

/**
 * Extract text from a file's bytes. `html2text` turns HTML files into readable text.
 * Returns { kind, text }; throws an Error with a student-friendly message for unsupported files.
 */
export async function extractFileText(buf, { name, contentType, html2text = (s) => s, maxUnzipped = MAX_UNZIPPED_BYTES }) {
  const kind = kindOf(name, contentType);
  if (!kind) {
    throw new Error(`Can't read "${name}". Supported: PDF, Word (.docx), PowerPoint (.pptx), web pages and plain-text files. Older .doc and .ppt files aren't supported; ask for a PDF version or open them in Office and save as .docx/.pptx.`);
  }
  let text;
  if (kind === 'pdf') text = await pdfText(buf);
  else if (kind === 'docx') text = await docxText(buf, { max: maxUnzipped, left: maxUnzipped });
  else if (kind === 'pptx') text = await pptxText(buf, { max: maxUnzipped, left: maxUnzipped });
  else if (kind === 'html') text = html2text(Buffer.from(buf).toString('utf8'));
  else text = Buffer.from(buf).toString('utf8');
  return { kind, text };
}
