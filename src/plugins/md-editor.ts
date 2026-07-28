/**
 * Configure md-editor-v3 for preview-only use without CDN script/style loads.
 * CSP script-src is 'self' only (+ wasm-unsafe-eval); md-editor defaults pull
 * cdnjs (hljs/mermaid/katex) + alicdn iconfont which would be blocked.
 */
import MdEditor from 'md-editor-v3';
import hljs from 'highlight.js';
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
    },
  });
}
