const assert = require('assert/strict');
const { JSDOM } = require('jsdom');

async function run() {
  const dom = new JSDOM('');
  global.window = dom.window;
  const { renderDescription } = await import('../client/src/markdown.mjs');
  const html = renderDescription('**Safe text**\n<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n[link](javascript:alert(1))');
  assert.match(html, /<strong>Safe text<\/strong>/);
  assert.doesNotMatch(html, /<script|onerror|href=["']?javascript:/i);
  assert.doesNotMatch(renderDescription('[link](javascript:alert(1))'), /href=["']?javascript:/i);
  assert.doesNotMatch(renderDescription('<a href="javascript:alert(1)">link</a>'), /href=["']?javascript:/i);
  assert.match(renderDescription('[Boardly](https://example.com)'), /href="https:\/\/example.com"/);
  dom.window.close();
  delete global.window;
  console.log('PASS: descriptions preserve markdown and remove executable HTML/links');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
