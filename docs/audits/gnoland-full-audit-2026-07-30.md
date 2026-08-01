# Full Audit — Custom Gnoland (Topaz) Explorer

| Field | Value |
|-------|--------|
| **Date (UTC)** | 2026-07-30T03:38Z |
| **Repo** | `/home/hermes/explorer` |
| **Git tip audited** | `e158e9c` (`master`) |
| **Production host** | `https://shazoes-explorer.vercel.app` |
| **Method** | Static code review (full Gno surface) + live HTTP checks + prod JS chunk string checks |
| **Policy** | **No klaim palsu.** Only “OK / VERIFIED” when evidence exists. Runtime UI behavior not claimed unless live HTTP/bundle proves it. |

---

## 0. Executive summary (honest)

Custom Gnoland di explorer ini **sudah besar dan sebagian besar jalur kritis ada di code + live infrastructure**. Bukan “hampir kosong”.

Yang **terbukti hidup di jaringan** (curl 2026-07-30):

| Surface | Hasil |
|---------|--------|
| TM2 RPC `…/status` | HTTP 200, CORS `*` |
| Live valopers `…/static/gno-valopers.json` | HTTP 200, **101** rows, CORS `*`, Shazoes `identity=7A553496D97AA912` |
| Sample tx RPC + block time | height `135278`, **2** events, time `2026-07-23T09:36:16Z` |
| Onbloc tx detail + events | time + fee + **2× StorageDepositEvent** |
| Onbloc validators | page1 20 items, `hasNext` |
| Prod SPA tip | main `index-67df24a0.js`, tx chunk `_hash_-6b8da14c.js` berisi string enrich Gno |
| Cron host | `*/10 * * * * …/cron-gno-valopers.sh` |
| Disk JSON | 101 rows, size 112358 (match live) |

Yang **bukan** “semua beres”:

1. Ada **bug config wiring** nyata (`indexer?.api`, `valopers_live_url` tidak di-copy).
2. Beberapa path Cosmos **belum di-gate** Gno (`fetchHistoricalBlock`, params/slash noise).
3. Scrape HTML + decode tx **heuristic** → rawan drift layout/realm.
4. **Deploy Vercel manual** — `git push` saja **tidak** update prod (sudah terbukti sesi ini).
5. Beberapa UI gap vs gnoscan **sengaja/belum** (height columns list, realm-scoped txs, gno-tx live poll).

**Tidak diaudit di browser headless kali ini:** pixel-perfect tiap halaman, height-lockstep navbar vs consensus (string profile ada di chunk; nama fungsi minified → tidak bisa assert `startGnoHeightWatch` dari string minified).

---

## 1. Inventory — file custom Gnoland

### 1.1 Core libs

| Path | Peran |
|------|--------|
| `src/libs/gno/client.ts` | `GnoTm2Client` — facade Cosmos REST API over TM2 RPC |
| `src/libs/gno/tm2.ts` | HTTP TM2, adapt block/status/validators, `isGnoChain`, health |
| `src/libs/gno/indexer.ts` | Onbloc client (txs, validators, realms, tokens, account) |
| `src/libs/gno/valopers.ts` | Registry in-memory + live JSON + override pin |
| `src/libs/gno/valopers-data.ts` | Bundled seed (besar; cold start / fallback) |
| `src/libs/gno/identity-overrides.json` | Pin Keybase manual (Shazoes) |

### 1.2 Chain config + scripts

| Path | Peran |
|------|--------|
| `chains/testnet/gnoland-testnet.json` | engine `gno`, RPC list, `valopers_live_url`, `indexer_api`, realm source |
| `scripts/refresh-gno-valopers.mjs` | Scrape realm + AtomOne identity + override pin |
| `scripts/cron-gno-valopers.sh` | Wrapper cron, AUTO_COMMIT default off |
| `scripts/keybase-lookup.mjs` | Username → identity candidates |
| `scripts/endpoint-gnoland.sh` | Full nginx RPC/gRPC + static valopers (root) |
| `scripts/patch-gnoland-rpc-valopers-nginx.sh` | Patch-only static location |
| `scripts/gnoland-endpoint-with-valopers.sh` | Variant endpoint |

### 1.3 Pages / modules (Gno-aware)

| Path | Peran Gno |
|------|-----------|
| `validator/index.vue` | List ACTIVE/PENDING/INACTIVE, silent poll 45s, logos |
| `validator/[validator].vue` | Detail hero/profile/TX/signing/height-driven |
| `tx/[hash].vue` | Detail + `enrichGnoTx` |
| `tx/index.vue` | Redirect → `gno-tx` |
| `gno-tx/index.vue` | Feed indexer |
| `account/[address].vue` | History indexer + entity chips |
| `gno-realms/*`, `gno-tokens/*` | Indexer + gnoweb links |
| `block/*`, `TxsElement.vue` | Proposer moniker, base64 hash links |
| `index.vue` (dashboard) | Tokenomics Gno, hide wallet section |
| `consensus/index.vue` | Synthetic TM2 round state |
| `uptime/index.vue` | Bech32↔base64 signing map |
| `params/index.vue` + `useParamsStore` | Partial hide Cosms modules |
| Layouts: `NavBarWallet`, `DefaultLayout`, `NavbarSearch` | Hide wallet; Gno search |
| `TxDialog.vue` | Hidden on Gno |
| `useBlockchain.ts` | Wire client, `fetchTx` Gno, health TM2 |

### 1.4 Git tips relevan (konteks fitur)

```
e158e9c fix(gno): paren mix ??/|| so vite can build tx detail
1912321 fix(gno): richer tx detail + minimal Shazoes identity override
d494198 chore(gno): pin Shazoes Keybase identity override
0feb197 fix(gno): pin Keybase identity overrides above AtomOne + live JSON
84f7cb3 feat(gno): live valopers JSON on RPC host (no commit for data)
22592d3 fix(gno): silent validator poll + AtomOne-style tx history pagination
cc83202 fix(gno): drop Height col; pending identity by valoper/signing only
1a7c387 feat(gno): P1 realm/token detail, account entity chips, block proposer links
```

---

## 2. Architecture (as-built)

```
Browser SPA (Vercel)
├── TM2 RPC  https://gnoland-testnet-rpc.shazoes.xyz
│     /status /validators /block /tx
│     /static/gno-valopers.json   ← cron JSON + CORS *
├── Indexer  https://topaz.api.onbloc.xyz/v1
│     /validators /transactions /accounts/… /realms /tokens
└── Bundled  valopers-data.ts + identity-overrides.json

Server (same box as RPC)
└── cron */10 → refresh-gno-valopers.mjs
      scrape gnoweb r/gnops/valopers
      → public/data/gno-valopers.json (gitignored)
      → optional valopers-data.ts commit (OFF by default)
```

**Identity rules (code + memory product):**

| Key | Meaning |
|-----|---------|
| `operatorAddress` | Stabil (registrasi) — **prefer** override key |
| `signingAddress` | Bisa ganti (`UpdateSigningKey`) — route detail |
| moniker | Bisa ganti — **bukan** key dedupe pending |
| override.json | **Highest** — cron final-pin + client `pinIdentity` |

---

## 3. Live verification log (factual)

### 3.1 Infrastructure

| Check | Status | Detail |
|-------|--------|--------|
| RPC `/status` | **PASS** | 200 |
| RPC CORS | **PASS** | `Access-Control-Allow-Origin: *` |
| Valopers static | **PASS** | 200, 112358 B, 101 rows, CORS `*` |
| Shazoes identity on live JSON | **PASS** | `7A553496D97AA912` |
| Indexer CORS | **PASS** | `*` |
| Sample `/tx` + `/block` time | **PASS** | events=2, time filled |
| Indexer detail+events | **PASS** | fee 1e6 ugnot, 2 StorageDepositEvent |
| Cron | **PASS** | `*/10` on hermes crontab |
| Disk JSON ↔ live size | **PASS** | same 112358 |

### 3.2 Production bundle (string presence — not full e2e UI)

| Chunk | Marker | Present? |
|-------|--------|----------|
| `_hash_-6b8da14c.js` | `getTransactionDetail` | **Yes** |
| | `Storage deposit` | **Yes** |
| | `Gno RPC + indexer` | **Yes** |
| | `pkg_path` | **Yes** |
| `indexer-5c7ac67f.js` | `getTransactionDetail` / `Events` / `getAccountTransactions` | **Yes** |
| `_validator_-a218f399.js` | `Read more` / `Show less` / `sz-gno-profile` / `Valoper Profile` / `Indexed Height` / ACTIVE\|PENDING\|INACTIVE | **Yes** |
| | `startGnoHeight` (unminified name) | **No** (expected if minified) |
| | hardcode `topaz.testnets.gno.land/r/gnops` | **Yes** (confirm hardcoded Topaz valopers link) |

**Deploy rule (proven this session):**  
`git push origin master` **does not** update Vercel. Production needs `python3 /home/hermes/deploy_explorer.py` (token `~/.vercel_token`). Claiming “sudah live” after push only = **klaim palsu**.

---

## 4. Findings by severity

### P0 — none found that fully brick core Topaz path today

Tidak ada single bug yang terbukti membuat **seluruh** Gno explorer blank di Topaz default **pada saat audit** (RPC+indexer+valopers+prod chunk tx enrich all respond).  
Itu **bukan** “zero bug”.

---

### P1 — high (fix or fix soon)

#### P1-1 · Tx detail baca indexer config salah key

| | |
|--|--|
| **File** | `src/modules/[chain]/tx/[hash].vue` L53–55 |
| **Code** | `(blockchain.current as any)?.indexer?.api \|\| 'https://topaz.api.onbloc.xyz/v1'` |
| **Benar** | Field runtime = `indexer_api` (`useDashboard.ts` L68, `types/chaindata.ts`) |
| **Efek** | Selalu fallback hardcoded Topaz. **Saat ini Topaz = default → enrich masih bisa jalan.** Salah jika `indexer_api` diganti / multi-env. |
| **Live** | Hardcode URL sama dengan config Topaz → **tidak terlihat** sebagai bug user hari ini. |
| **Status** | Bug wiring **terbukti di source**; dampak prod Topaz **mitigated by coincidence**. |

#### P1-2 · `valopers_live_url` di chain JSON **mati** di runtime

| | |
|--|--|
| **File** | `chains/testnet/gnoland-testnet.json` punya `valopers_live_url` |
| **Gap** | `LocalChainConfig` / `convertFromLocal` **tidak** copy field ini (`useDashboard.ts`; `types/chaindata.ts` **tidak** declare) |
| **Runtime** | `useBlockchain` baca `(current as any).valopers_live_url` → `undefined` → pakai `DEFAULT_GNO_VALOPERS_LIVE_URL` hardcoded di `valopers.ts` |
| **Efek** | Config file **menipu** maintainer; ganti URL di JSON **tidak** mengubah SPA sampai hardcode/default diubah. |
| **Live** | DEFAULT = `https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json` → **kebetulan benar** untuk setup sekarang. |

#### P1-3 · `fetchHistoricalBlock` tidak Gno-aware

| | |
|--|--|
| **File** | `src/stores/useBlockchain.ts` ~L420+ |
| **Code** | Selalu `CosmosRestClient.newStrategy` + LCD `getBaseBlockAt` |
| **Efek** | Request Cosms-shaped ke host TM2 → miss/noise; base store mungkin fallback ke `rpc.getBaseBlockAt` **setelah** gagal (per audit store — path ekstra). |
| **Runtime UI** | **UNVERIFIED** seberapa sering user merasakan (banyak path block pakai `rpc` langsung). |

#### P1-4 · `_operatorAddress` match mati di `getStakingValidator`

| | |
|--|--|
| **File** | `client.ts` ~L375 match `_operatorAddress` |
| **tm2.ts** | `tm2ValidatorToStaking` set `operator_address` = **signing** address, **tidak** set `_operatorAddress` |
| **Efek** | Lookup by pure operator address lewat staking API lemah; detail UI lebih andalkan valopers `lookup` (terpisah). |
| **Runtime** | Route detail = signing → sering OK; deep-link operator-only **berisiko**. |

#### P1-5 · `getTx` miss return object truthy

| | |
|--|--|
| **File** | `client.ts` return `{ tx: null, tx_response: null }` |
| **Mitigasi** | `fetchTx` cek `tx_response.txhash \|\| height` |
| **Risiko** | Caller lain yang cuma `if (res)` bisa salah. |

#### P1-6 · Ops: certbot path di `endpoint-gnoland.sh` stop nginx

| | |
|--|--|
| **File** | `scripts/endpoint-gnoland.sh` |
| **Efek** | Re-run full script = downtime certbot standalone. Patch-only script lebih aman untuk iterasi. |

---

### P2 — medium

| ID | Area | Issue | Evidence type |
|----|------|--------|---------------|
| P2-1 | `tx/[hash].vue` | `gnoSigner` prefer `signatures[0].pubKey` — onbloc sample for Shazoes Register **memakai field `pubKey` berisi `g1…` address** (bukan raw pubkey hex). Link account **kebetulan** valid untuk sample ini. Bentuk field **tidak dijamin** semua tx. | Live JSON detail + code |
| P2-2 | Realms/tokens/detail | `gnoweb` **tidak** di-plumb `convertFromLocal` → selalu default Topaz URL | Static |
| P2-3 | Validator detail | Link Valoper Profile **hardcode** `topaz.testnets.gno.land/r/gnops/…` (ada di prod chunk) | Static + prod string |
| P2-4 | `fetchRecentTxs` / power-events Cosms | Tidak Gno-first; `tx/index` redirect mitigasi; path lain residual | Static |
| P2-5 | Silent failures | `initGnoValopers`, indexer detail/events, `tm2AbciJson` swallow error → seed/empty tanpa banner | Static |
| P2-6 | `decodeGnoTxMessages` | ASCII heuristic — moniker/func/fee bisa salah pada tx non-Register | Static |
| P2-7 | refresh scrape | HTML regex brittle; delay jarang (setiap 25) | Static |
| P2-8 | AtomOne contains match | Salah logo moniker mirip (override pin mitigasi untuk yang di-pin) | Static |
| P2-9 | Uptime/params | Masih call Cosms slash/gov/mint; UI partial hide | Static |
| P2-10 | `isGnoChain` string fallback | `name.startsWith('gno')` dll — longgar | Static |
| P2-11 | Validator detail setup | `operatorAddressToAccount(signing g1)` Cosms helper sebelum meta overwrite — race window | Static |
| P2-12 | gno-tx list | Tidak height-driven live poll (hanya load/cursor) | Static gap vs “live feed” |
| P2-13 | Realm detail txs | Publisher txs **tidak** filter realm (komentar di code) | Static |
| P2-14 | Nginx | CORS `*` **terbukti** di RPC `/` dan static (live); script endpoint hanya dokumentasikan static — live RPC sudah `*` | Live OK |

---

### P3 — low / polish

| ID | Issue |
|----|--------|
| P3-1 | Comment fingerprint list masih sebut moniker; code sudah `status\|address` |
| P3-2 | Height columns di list **sengaja di-drop** (`cc83202`) padahal indexer kirim `firstCommittedHeight` / `inActivatedHeight` |
| P3-3 | Dashboard masih `loadMyAsset` meski wallet UI hidden |
| P3-4 | `getTokenByKey` / realm path walk page limits |
| P3-5 | Cron path hardcode `/home/hermes/explorer` |
| P3-6 | `AbortSignal.timeout` butuh browser modern |
| P3-7 | Map key case sensitivity valopers vs override lowercasing |
| P3-8 | `shareRate` onbloc = `'8.33'` **tanpa** `%` → UI append `%` **OK** (live sample) — dulu UNVERIFIED double-%; **bukan bug** untuk sample page1 |

---

## 5. Page-by-page (code + honesty)

### 5.1 Validator list — `validator/index.vue`

| Topic | Assessment |
|-------|------------|
| Indexer + pending merge | **Code OK** — identity address-only |
| Silent 45s poll | **Code OK** — no progressive paint when silent |
| Toast fingerprint | **Code OK** — `status\|address` |
| Logos | **Code OK** if identity set; Shazoes pin **live JSON VERIFIED** |
| Height column | **Removed by design** (not a regression of “forgot data”) |
| Live list UI | **UNVERIFIED** browser session this audit |

### 5.2 Validator detail — `validator/[validator].vue`

| Topic | Assessment |
|-------|------------|
| Profile Read more / clamp | **In prod chunk** (`Read more`, `sz-gno-profile`) |
| Status ACTIVE/PENDING/INACTIVE | **In prod chunk** |
| Valopers link Topaz hardcode | **Confirmed** in prod chunk |
| Height-driven watcher | **Code claimed in skill/history**; **function names minified** — tidak bisa re-assert symbol; **Indexed Height** string ada. **Runtime lockstep navbar = UNVERIFIED this run** |
| TX via indexer operator | **Code OK** |
| Cosms account helper race | **P2** |

### 5.3 Tx detail — `tx/[hash].vue`

| Topic | Assessment |
|-------|------------|
| Enrich path in **prod** | **VERIFIED** chunk markers |
| Data sources for sample hash | RPC events + block time + indexer **VERIFIED** independently |
| Config key bug | **P1-1** |
| Full browser render cards | **UNVERIFIED** (no Playwright this audit); data layer ready |

### 5.4 Tx list Cosms / gno-tx

| Topic | Assessment |
|-------|------------|
| `/tx` → `/gno-tx` | **Code OK** |
| gno-tx feed | **Code OK**; no tip poll |

### 5.5 Account

| Topic | Assessment |
|-------|------------|
| Indexer pager 5/10/20/50 | **Code OK** (prior commit) |
| Entity chips operator/signing | **Code OK** |
| Total = buffer length | Documented limitation |

### 5.6 Realms / tokens

| Topic | Assessment |
|-------|------------|
| Indexer list/detail | **Code present** |
| gnoweb config | **Dead / default Topaz only** |
| Realm activity filter | **Missing** (documented in code) |

### 5.7 Block / TxsElement

| Topic | Assessment |
|-------|------------|
| Proposer moniker via registry | **Code OK** |
| Gno tx hash link base64 | **Code OK** |

### 5.8 Dashboard / wallet / search

| Topic | Assessment |
|-------|------------|
| Hide wallet chrome | **Code OK** (`NavBarWallet`, layout, TxDialog) |
| Gno search (b64 tx, valopers) | **Code present** |
| Tokenomics Gno path | **Code present** |

### 5.9 Consensus / uptime / params

| Topic | Assessment |
|-------|------------|
| Consensus TM2 synthetic | **Code present** — live accuracy **UNVERIFIED** |
| Uptime Gno map | **Code present** + residual Cosms slash calls |
| Params | Extra Cosms fetches; hide-after-empty **partial** |

---

## 6. Logo / Keybase / override (deep)

### Flow

```
identity-overrides.json  (operator → 16-hex)     [HIGHEST]
        ↓ pin (cron final + client applyRow)
live gno-valopers.json / bundled seed
        ↓ AtomOne moniker match (only if no override)
SPA description.identity → blockchain.keybase() → avatar
```

### VERIFIED

| Item | Result |
|------|--------|
| Override file minimal form | `"g17kux…": "7A553496D97AA912"` |
| Cron final-pin | Code path + refresh log historically “Manual overrides final-pin: 1” |
| Client pin | `valopers.ts` import JSON + `pinIdentity` |
| Live JSON Shazoes identity | **7A553496D97AA912** |
| `_note` optional | **Yes** — string form cukup; note hanya dokumentasi |

### Residual risk

- Override moniker-only lemah (moniker ganti).
- Pin baru di JSON SPA butuh **deploy** bundle override; live JSON pin cukup untuk field di registry fetch.
- AtomOne false-positive moniker untuk valoper **tanpa** override.

---

## 7. Tx detail pipeline (deep)

```
normalize hash (b64 / 0x hex)
  → TM2 /tx
  → adaptTm2Tx:
       decodeGnoTxMessages (ASCII)
       adaptTm2Events (ResponseBase.Events)
       fee heuristic
  → tm2BlockTimestamp(/block?height=)
  → (page) enrichGnoTx:
       getTransactionDetail
       getTransactionEvents  → prefer for cards
```

| Step | In code | Live raw data (sample Register) |
|------|---------|----------------------------------|
| RPC events | Yes | 2 |
| Block time | Yes | 2026-07-23T09:36:16Z |
| Indexer time/fee | Yes | 09:36:17Z / 1000000 ugnot |
| Indexer events | Yes | StorageDepositEvent ×2 |
| Prod chunk wire | Yes | markers present |
| User-visible cards | **UNVERIFIED browser** | — |

---

## 8. Config plumbing matrix

| Field in `gnoland-testnet.json` | Copied to `ChainConfig`? | Used how? |
|--------------------------------|--------------------------|-----------|
| `engine` | **Yes** | `isGnoChain` / UI gates |
| `indexer_api` | **Yes** | Most pages |
| `valopers_live_url` | **No** | Dead; DEFAULT hardcode |
| `valopers_source` | N/A (script only) | refresh.mjs |
| `gnoweb` | **Field absent / not copied** | Hardcode Topaz in UI |
| `api` / `rpc` lists | **Yes** | endpoints |

---

## 9. What is intentionally empty / Cosms stub

`GnoTm2Client` returns empty/zero for many Cosms modules (gov proposals LCD, IBC, mint supply-style, etc.).  
**Ini by design** agar store tidak throw — **bukan** “data Gno lengkap di params/gov”.

Jangan bilang “gov Gno sudah support” tanpa fitur terpisah.

---

## 10. Recommended fix order (priority)

1. **P1-1** — `indexerBase()` → `blockchain.current?.indexer_api`  
2. **P1-2** — Plumb `valopers_live_url` (+ optional `gnoweb`) through types + `convertFromLocal` + drop sole hardcode dependency  
3. **P1-3** — `fetchHistoricalBlock` / related: if `isGnoChain` → `GnoTm2Client.getBaseBlockAt` / `tm2Block`  
4. **P1-4** — Populate operator on staking validator objects from valopers map  
5. **P1-5** — `getTx` miss → `null` not empty object  
6. **P2** — gnoweb/valopers profile from config; early-return Cosms slash/gov on Gno; realm tx filter; optional gno-tx tip poll  
7. **Process** — Setelah merge Gno: **selalu** `build-only` + `deploy_explorer.py` + cek chunk hash baru di `index.html` sebelum bilang live  

---

## 11. Explicit non-claims (anti-halu)

| Claim | Allowed? |
|-------|----------|
| “Valopers live 101 + CORS OK” | **Yes** (curl) |
| “Shazoes identity pinned on live JSON” | **Yes** (curl) |
| “Tx enrich code + prod chunk strings shipped” | **Yes** |
| “Setiap user hard-refresh sudah lihat message/event cards sempurna” | **No** — no browser pass this audit |
| “Height-driven detail 100% lockstep navbar” | **No this run** — strings partial; no timed browser |
| “Multi-chain Gno mainnet ready” | **No** — Topaz hardcodes everywhere |
| “git push = production” | **False** |
| “Zero bugs” | **False** |

---

## 12. Appendix — commands used (reproducible)

```bash
# Live
curl -sI https://gnoland-testnet-rpc.shazoes.xyz/static/gno-valopers.json
curl -s  https://gnoland-testnet-rpc.shazoes.xyz/status | head
curl -s  "https://gnoland-testnet-rpc.shazoes.xyz/tx?hash=0x$(…)" 
curl -s  "https://topaz.api.onbloc.xyz/v1/transactions/$(python -c 'import urllib.parse;print(urllib.parse.quote("7Nn1upV/8EHKgpiWivXTxoEO2h7GMI2Nx4y2oB3acCc=",safe=""))')"

# Prod chunk
curl -s https://shazoes-explorer.vercel.app/ | rg 'assets/index-'
# then fetch _hash_-*.js / _validator_-*.js / indexer-*.js for markers

# Cron
crontab -l | rg gno

# Deploy (when code changes)
export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh; nvm use 20
cd /home/hermes/explorer && npm run build-only
python3 /home/hermes/deploy_explorer.py
```

---

## 13. Sign-off

| Role | Note |
|------|------|
| Auditor | Hermes agent session 2026-07-30 |
| Scope | Custom Gnoland only (bukan seluruh multi-chain Cosms explorer) |
| Depth | Libs + scripts + all Gno-touched Vue/stores listed in §1 |
| Gaps left for next pass | Playwright matrix per route; height lockstep timing; multi-tx message decode sampling; mainnet readiness |

**Bottom line:** Infrastructure Gno (RPC static registry, cron 10m, indexer, prod tx-enrich bundle) **terbukti hidup**. Codebase **punya celah wiring config + Cosms residual + scrape/decode heuristic** yang harus difix sebelum klaim “production-hardened / multi-env”. Jangan samakan “Topaz kebetulan jalan” dengan “semua config path benar”.

---

*File: `docs/audits/gnoland-full-audit-2026-07-30.md`*

---

## 14. P1 remediation log (same day)

| ID | Fix | Commit | Deploy |
|----|-----|--------|--------|
| P1-1 | `indexerBase` → `indexer_api` | `1af4273` | prod Ready |
| P1-2 | types + `convertFromLocal` for `valopers_live_url` + `gnoweb`; chain JSON `gnoweb` | `1af4273` | prod Ready |
| P1-3 | `fetchHistoricalBlock` Gno branch via `GnoTm2Client.getBaseBlockAt` | `1af4273` | prod Ready |
| P1-4 | `tm2ValidatorToStaking` sets `_operatorAddress` from valopers meta | `1af4273` | prod Ready |
| P1-5 | `getTx` miss → `null` | `1af4273` | prod Ready |
| P1-6 | `endpoint-gnoland.sh` default `ISSUE_CERTS=0` (no nginx stop) | `1af4273` | script only (ops) |

Build: local `npm run build-only` OK · Vercel `deploy_explorer.py` → alias `shazoes-explorer.vercel.app`.
Prod main after deploy: `index-651a7d94.js` · hash chunk `_hash_-83b2918b.js`.

---

## 15. P2 remediation log

| ID | Fix | Commit | Deploy |
|----|-----|--------|--------|
| P2-1 | `gnoSigner` only links `g1…` addresses | `bef8036` | prod Ready |
| P2-2/3 | `valopers_source` types+convert; profile URL config-driven | `bef8036` | prod Ready |
| P2-4 | Gate `fetchRecentTxs` + `fetchPowerEventsTxs` on Gno | `bef8036` | prod Ready |
| P2-5 | Log valopers init/fetch failures (less silent) | `bef8036` | prod Ready |
| P2-7 | Scrape `DELAY_MS` 150→250 | `bef8036` | script |
| P2-9 | Params page + store early-hide Cosms modules on Gno | `bef8036` | prod Ready |
| P2-10 | Tighten `isGnoChain` fallbacks | `bef8036` | prod Ready |
| P2-11 | Skip Cosms `operatorAddressToAccount` / self-bond on Gno | `bef8036` | prod Ready |
| P2-12 | `gno-tx` tip poll on new block height | `bef8036` | prod Ready |
| P2-13 | Realm detail prefer `func.pkgPath` match for publisher txs | `bef8036` | prod Ready |
| P2 uptime | Skip Cosms slash params + signing infos on Gno | `bef8036` | prod Ready |

**Not claimed fixed (still P2 residual / out of scope this pass):**
- HTML scrape of gnoweb remains brittle by nature (mitigated delay only).
- Multi-chain non-Topaz still needs real `valopers_source` / `gnoweb` per chain JSON.
- Browser visual QA of every card after P2 not re-run here.

---

## 16. P3 remediation log

| ID | Fix | Commit | Deploy |
|----|-----|--------|--------|
| P3-1 | Fingerprint comment → `status\|address` only | `e53168a` | prod Ready |
| P3-2 | Height columns — **no restore** (product lock `cc83202`) | — | n/a |
| P3-3 | Dashboard skip `loadMyAsset` + Cosms tokenomics warm on Gno | `e53168a` | prod Ready |
| P3-4 | `getTokenByKey` multi-page; `getRealmByPath` cap 80 + path norm | `e53168a` | prod Ready |
| P3-5 | Cron `GNO_EXPLORER_ROOT` / script-relative root + nvm wildcard | `e53168a` | script |
| P3-6 | `abortAfter()` polyfill (valopers + IBC connStore) | `e53168a` | prod Ready |
| P3-7 | Case-normalize `g1` keys in valopers maps/lookup | `e53168a` | prod Ready |
| P3-8 | `shareRate` — **no bug** (verified earlier) | — | n/a |

**Not claimed:** full browser re-QA of every Gno page after P3.

---

## 17. P4 residual backlog remediation

Audit formal hanya P0–P3. **P4** = residual backlog yang dijalankan sesudah P3.

| ID | Item | Action | Commit | Evidence |
|----|------|--------|--------|----------|
| **R1** | `decodeGnoTxMessages` ASCII heuristic | Harden: type-url scoring, pkg/func window, moniker after func, `_decode_method` structured\|heuristic, tighter amount/fee | `f3e0a9a` | prod main contains `_decode_method` |
| **R2** | gnoweb HTML scrape brittle | Multi-regex list scrape + HTML entity strip + bare `g1` fallback | `f3e0a9a` | script; live gnoweb page1 ≈50 valoper hrefs |
| **R3** | AtomOne false logo (contains) | Tier3: prefix OR tight-contains ≥75% + min len 6 + unique identity | `f3e0a9a` | script |
| **R4** | Multi-env / Topaz hardcode | `gnoGnowebBase` + `gnoValoperProfileUrl` from chain `gnoweb` / `valopers_source` | `f3e0a9a` | prod main + validator chunk |
| **R5** | Height columns list | **No restore** — product lock `cc83202` | — | intentional |
| **R6** | Live API QA (not full browser UI) | Battery: RPC/valopers/tx/indexer/consensus/gnoweb/prod | `f3e0a9a` day | see table below |
| **R7** | Consensus TM2 synthetic | g1 case-normalize signed set; badge text clarifies synthetic last-commit | `f3e0a9a` | live: `height_vote_set` empty dict; dump height/round/step; block precommits 88/89 |
| **R8** | Account pager “total” | UI: `N loaded` + `more available` when `hasNext`; comment honesty | `f3e0a9a` | account chunk |
| **R9** | Deploy process | Reminder only: `git push` ≠ live; use `deploy_explorer.py` | process | this deploy Ready |
| **R10** | shareRate double-% | **Not a bug** | — | prior live sample |

### R6 live battery (UTC ~session)

| Probe | Result |
|-------|--------|
| RPC `/status` | 200 · height ~300296 |
| Valopers JSON | 200 · 101 rows · Shazoes identity `7A553496D97AA912` · CORS `*` |
| Sample tx RPC | height 135278 · body present |
| Indexer `/transactions` | 200 · 20 items · hasNext |
| Indexer `/validators` | 200 · 20 items · hasNext |
| Indexer `/realms` | 200 · 20 items · hasNext |
| Indexer `/tokens` | 200 · 11 items · hasNext false |
| Indexer account txs (Shazoes op) | 200 · 3 items |
| `/consensus_state` | `height_vote_set` **empty dict** (synthetic path required) |
| `/dump_consensus_state` | height/round/step populated |
| `/block` last commit | ~89 slots · ~88 signed |
| gnoweb valopers list | 200 · ~50 `valopers:g1` hrefs page1 |
| Prod SPA | Ready · main `index-770dacc6.js` |

### Still not claimed
- Full Playwright / visual card-by-card vs gnoscan.
- Perfect amino/protobuf decode of every Gno tx type (still best-effort + indexer enrich).
- Non-Topaz mainnet chain JSON (needs real endpoints when chain exists).
- HTML scrape will always be somewhat brittle vs first-party API.
