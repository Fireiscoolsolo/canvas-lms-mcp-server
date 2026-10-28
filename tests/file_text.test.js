import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { extractFileText, kindOf, officeXmlText } from '../file-text.js';

/** The smallest valid PDF with one line of text, with correct cross-reference offsets. */
function tinyPdf(line) {
  const content = `BT /F1 18 Tf 20 100 Td (${line}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('kindOf picks a reader from the name or content type', () => {
  assert.equal(kindOf('Lecture 5.PDF'), 'pdf');
  assert.equal(kindOf('notes', 'application/pdf'), 'pdf');
  assert.equal(kindOf('essay.docx'), 'docx');
  assert.equal(kindOf('slides.pptx'), 'pptx');
  assert.equal(kindOf('page.html'), 'html');
  assert.equal(kindOf('data.csv'), 'text');
  assert.equal(kindOf('code.py'), 'text');
  assert.equal(kindOf('old.doc'), null);
  assert.equal(kindOf('video.mp4', 'video/mp4'), null);
});

test('officeXmlText joins runs per paragraph and decodes entities', () => {
  const xml = '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t xml:space="preserve">world &amp; more</w:t></w:r></w:p><w:p></w:p><w:p><w:t>Line 2</w:t></w:p>';
  assert.equal(officeXmlText(xml, 'w:t', 'w:p'), 'Hello world & more\nLine 2');
});

test('extractFileText reads Word documents', async () => {
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Chapter 3: Photosynthesis</w:t></w:r></w:p><w:p><w:r><w:t>Plants make sugar.</w:t></w:r></w:p></w:body></w:document>');
  const r = await extractFileText(await zip.generateAsync({ type: 'nodebuffer' }), { name: 'ch3.docx' });
  assert.deepEqual(r, { kind: 'docx', text: 'Chapter 3: Photosynthesis\nPlants make sugar.' });
});

test('extractFileText reads PowerPoint slides in order, with speaker notes', async () => {
  const zip = new JSZip();
  const slide = (t) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  zip.file('ppt/slides/slide1.xml', slide('Intro'));
  zip.file('ppt/slides/slide2.xml', slide('Cell structure'));
  zip.file('ppt/slides/slide10.xml', slide('Summary'));
  zip.file('ppt/slides/_rels/slide2.xml.rels', '<Relationships><Relationship Target="../notesSlides/notesSlide7.xml"/></Relationships>');
  zip.file('ppt/notesSlides/notesSlide7.xml', '<p:notes><a:p><a:r><a:t>Mention the mitochondria</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>');
  const r = await extractFileText(await zip.generateAsync({ type: 'nodebuffer' }), { name: 'week5.pptx' });
  assert.equal(r.kind, 'pptx');
  assert.equal(r.text, '--- Slide 1 ---\nIntro\n\n--- Slide 2 ---\nCell structure\nSpeaker notes: Mention the mitochondria\n\n--- Slide 3 ---\nSummary');
});

test('extractFileText reads PDFs page by page', async () => {
  const r = await extractFileText(tinyPdf('Hello Canvas'), { name: 'notes.pdf' });
  assert.equal(r.kind, 'pdf');
  assert.match(r.text, /^--- Page 1 ---\nHello Canvas/);
});

test('extractFileText handles text and HTML, and explains unsupported files', async () => {
  assert.deepEqual(await extractFileText(Buffer.from('a,b\n1,2'), { name: 'data.csv' }), { kind: 'text', text: 'a,b\n1,2' });
  const html = await extractFileText(Buffer.from('<p>Hi</p>'), { name: 'page.html', html2text: (s) => s.replace(/<[^>]+>/g, '') });
  assert.deepEqual(html, { kind: 'html', text: 'Hi' });
  await assert.rejects(extractFileText(Buffer.from('x'), { name: 'old.ppt' }), /Older \.doc and \.ppt files aren't supported/);
});
