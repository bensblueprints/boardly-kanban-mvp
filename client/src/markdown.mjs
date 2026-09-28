import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderDescription(text) {
  return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }), {
    USE_PROFILES: { html: true },
  });
}
