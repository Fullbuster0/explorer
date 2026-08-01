/**
 * Configure md-editor-v3 for preview-only use without CDN script/style loads.
 * CSP script-src is 'self' only (+ wasm-unsafe-eval); md-editor defaults pull
 * cdnjs (hljs/mermaid/katex) + alicdn iconfont which would be blocked.
 */
import MdEditor from 'md-editor-v3';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
// Dark theme CSS bundled into our app (no CDN stylesheet)
import 'highlight.js/styles/atom-one-dark.css';

// runtime attaches .config on default export
const configure = (MdEditor as any).config as (opt: Record<string, unknown>) => void;
if (typeof configure === 'function') {
  configure({
    editorExtensions: {
      // Bundled instance → md-editor skips injecting cdnjs highlight.min.js
      highlight: {
        instance: hljs,
      },
      // Defense-in-depth: md-editor renders Markdown→HTML with raw-HTML
      // passthrough, so sanitize globally. NOTE: verified this global hook is
      // NOT honored on the previewOnly path — each <MdEditor> MUST also pass
      // `:sanitize` explicitly (see TextElement.vue / index.vue). Kept here to
      // cover any editor-mode usage.
      sanitize: (html: string) => DOMPurify.sanitize(html),
    },
  });
}
