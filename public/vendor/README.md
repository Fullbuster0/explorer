# Vendored third-party assets

## `@ping-pub/widget@0.3.12`

Source: npm package `dist/` (not the jsDelivr single-file re-export — that only pointed at `./main-*.js` on the CDN).

| Entry | Path |
|-------|------|
| ES module entry | `/vendor/ping-widget/widget.js` |
| Main chunk | `/vendor/ping-widget/main-38c9029b.js` (~13.7MB) |
| Lazy chunks | `query.lcd-*.js`, `query.rpc.Query-*.js`, `tx.rpc.msg-*.js` |

Do **not** load only `widget.min.js` from jsDelivr without its sibling chunks.

Bump process:
1. `npm pack @ping-pub/widget@X.Y.Z`
2. Replace `public/vendor/ping-widget/` with package `dist/`
3. Smoke-test Connect Wallet + Send/Delegate dialog
4. Keep CSP `script-src 'self' 'wasm-unsafe-eval'` (widget + cosmjs use WASM)
