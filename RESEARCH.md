# RESEARCH.md — Solana Session Keys POC (Phase 0 findings)

> Verified 2026-06-17 against the live npm registry, GitHub source, official docs,
> and live Solana devnet RPC (`getAccountInfo`). Where something could not be
> confirmed, it is flagged explicitly. **No claim here is from training data alone.**
>
> **Update — both flows executed end-to-end on devnet** (real transaction
> signatures) via `npm run verify:swig` and `npm run verify:gum`. Doing so
> corrected one design assumption below: the Swig **root role must hold
> `ManageAuthority`/`All`** — a scoped-only root is rejected on-chain
> (`custom program error: 0x7`, "Root authority type must had one of the
> following actions: ManageAuthority or All"). The working design adds a
> **separate** session-capable authority scoped to `solLimit`. See §1.

---

## Bottom line

| | Swig | MagicBlock / Gum |
|---|---|---|
| Demo viable on devnet, no custom program? | ✅ **Fully** | ✅ **Yes**, with one honesty caveat |
| Spend cap enforced **on-chain**? | ✅ Yes (program enforces `Actions` limits) | ⚠️ Only if the **target program** does — the session program itself stores expiry, not spend caps |
| Expiry enforced **on-chain**? | ✅ Yes (slot-based, program-enforced) | ✅ Stored on-chain (`valid_until`); enforced by target program |
| Ephemeral session key signs without root popup? | ✅ Yes | ✅ Yes |
| Revoke path? | ✅ Yes (zero-key re-session) | ✅ Yes (`revokeSession`, closes PDA) |

**Conclusion:** Swig is the strong end-to-end demo (the deployed Swig program *itself*
enforces the spend cap + expiry — exactly the POC's goal). MagicBlock/Gum demonstrates
the session-token *primitive lifecycle* honestly, and can show a *real session-gated
state change* against an already-deployed third-party program (`lumberjack`), but the
"no custom program" rule means we cannot showcase a **custom spend-cap rule we control** —
that enforcement always lives inside a target program. This limitation is documented in
the UI and README, not faked.

---

## 1. Swig

### Packages & versions (npm-verified)
- **`@swig-wallet/classic@2.1.0`** — main SDK for `@solana/web3.js` 1.x. **Use this.**
- Transitive: `@swig-wallet/lib@2.1.0`, `@swig-wallet/coder@2.1.0`.
- `@swig-wallet/kit@2.1.x` — same API for `@solana/kit` (web3.js 2.0). Not used here.

```bash
npm i @swig-wallet/classic @solana/web3.js
```

- SDK repo: `github.com/anagrambuild/swig-ts` (TS) · program: `anagrambuild/swig-wallet` (Rust)
- Docs: https://build.onswig.com · TypeDoc: https://anagrambuild.github.io/swig-ts/modules.html
- License: Apache-2.0

### Devnet program ID (RPC-verified, `executable: true` on devnet AND mainnet)
```
swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB
```
Single fixed ID across clusters (Pinocchio program). Nothing to deploy.

### API surface we will call (source-verified, all from `@swig-wallet/classic`)
- `findSwigPda(id: Uint8Array)` → Swig **config** account address.
- `getSwigWalletAddress(swig)` → the address that actually **holds/spends funds** (fund THIS).
- `createEd25519AuthorityInfo(pubkey)` / `createEd25519SessionAuthorityInfo(pubkey, maxSessionDurationSlots: bigint)`.
- `Actions.set().solLimit({ amount }).get()` / `.tokenLimit({ mint, amount })` / `.all()` / `.manageAuthority()` — the spend-cap/scope builder.
- `getCreateSwigInstruction({ id, authorityInfo, actions, payer })`.
- `getCreateSessionInstructions(swig, roleId, sessionKey, durationSlots: bigint, { payer })`.
- `fetchSwig(connection, swigAddress)` → `swig.findRoleById(0)`, `swig.findRoleBySessionKey(pk)`, `role.isSessionBased()`, `role.actions.canSpendSol(bigint)`.
- `getSignInstructions(swig, roleId, [innerIx], false, { payer })` — wraps inner ix so the Swig PDA co-signs; **only the session keypair signs**.
- **Revoke:** `getCreateSessionInstructions(swig, rootRole.id, new Uint8Array(32).fill(0), 1n)` — zero-key invalidates the current session.

### Working scoped-session design (devnet-verified)
A scoped-only root is **rejected on-chain**. The verified pattern is two roles:
1. **Root (role 0):** `createEd25519AuthorityInfo(wallet)` + `Actions.set().all().get()` — full control, required by the program.
2. **Scoped session authority (role 1+):** added via `getAddAuthorityInstructions(swig, 0, createEd25519SessionAuthorityInfo(wallet, maxSlots), Actions.set().solLimit({ amount }).get())`.
3. Open the session on the scoped role: `getCreateSessionInstructions(swig, scopedRole.id, ephemeralKey, durationSlots)`.

The session key then inherits **only** `solLimit`. Confirmed on devnet:
`canSpendSol(0.02) === true`, `canSpendSol(0.15) === false`; a 0.02-SOL transfer
signed solely by the session key **succeeds**, a 0.15-SOL transfer is **rejected**
by the program, and after a zero-key revoke the session key is no longer a role.

### What the deployed Swig program enforces (the POC's whole point)
- **Spend cap:** on-chain, against the role's `Actions` (`solLimit`/`tokenLimit`). A `sign` exceeding it is rejected by the program.
- **Expiry:** `create_session_v1` reads `Clock::get()?.slot`, stores `expiry = slot + duration`; a `sign` after expiry is rejected on-chain. Capped by `maxSessionLength` from authority creation.

### Critical gotchas (will break the demo if ignored)
1. **Duration is in SLOTS, not seconds and not lamports** (~400ms/slot; `50n` ≈ 20s). The official example's inline "lamports" comments are a **documented error** — verified against `createAuthority.ts` and `create_session_v1.rs`. Spend caps are separate (`Actions`, in lamports/base units).
2. **Fund the Swig wallet address** (`getSwigWalletAddress(swig)`), NOT `findSwigPda(id)` — transfers move SOL out of the wallet address.
3. **Each session needs a fresh ephemeral key** — cannot reuse a prior session key.
4. **The session keypair pays tx fees**, so it must hold a little SOL and is a required signer (per docs). Use paymaster packages for gasless (not in scope).
5. Devnet airdrops are rate-limited → add delays / use `confirmed` commitment.

### Could NOT fully confirm (flagged)
- Exact args of `getRemoveAuthorityInstructions` (the program action `remove_authority_v1` exists; no verbatim TS snippet found). We will use the **zero-key re-session** revoke path, which IS documented.

---

## 2. MagicBlock / Gum

### Packages & versions (npm-verified) — the naming MOVED
- ❌ **DEAD:** `@gumhq/react-sdk@3.0.1` (last published 2023-06-29). Do not use.
- ✅ **CURRENT:** `@magicblock-labs/gum-react-sdk@3.0.10` (2025-11-26) + core `@magicblock-labs/gum-sdk@3.0.10`.
  - Maintenance reality (honest): single maintainer, ~118 downloads/month, thinly maintained. The **on-chain program is actively maintained** (last commit 2026-05-26), but the **published JS SDK lags** the program (only wires V1 `createSession`/`revokeSession`).

```bash
npm i @magicblock-labs/gum-react-sdk @magicblock-labs/gum-sdk
```

### Session-keys program ID (RPC-verified, `executable: true` on devnet AND mainnet)
```
KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5
```
Repo: `github.com/magicblock-labs/session-keys` (program) · `magicblock-labs/gum-sdk` (TS).
Docs: https://docs.magicblock.gg/pages/tools/session-keys/introduction

### API surface (source-verified)
- `useSessionKeyManager(wallet, connection, cluster)` → `SessionWalletInterface`.
- `SessionWalletProvider` / `useSessionWallet()`.
- `createSession(targetProgram: PublicKey, topUpLamports?, validUntil?, cb?)` — generates an **ephemeral Keypair**, signs **once**, creates the on-chain `SessionToken` PDA.
- `revokeSession()` — closes the PDA, sweeps remaining lamports back, returns rent to authority.
- `signTransaction` / `signAllTransactions` / `sendTransaction` — sign with the ephemeral key.
- Ephemeral key + token stored **encrypted in IndexedDB** (browser-only — fine for our web POC).

### The on-chain `SessionToken` account (the real primitive)
```rust
pub struct SessionToken {       // PDA seeds: ["session_token", target_program, session_signer, authority]
    authority: Pubkey,          // your real wallet
    target_program: Pubkey,     // program this token is scoped to
    session_signer: Pubkey,     // ephemeral keypair
    valid_until: i64,           // expiry (capped on-chain to now + 7 days)
}
```
This is genuinely created/scoped/closed by the deployed program — a real, inspectable on-chain account.

### Constraint analysis — what's demonstrable with NO custom program
- **(a) Real session-gated action against an EXISTING deployed program:** the Solana Foundation `lumberjack` game — `MkabCfyUD6rBTaYHpgKBBpBo5qzWA2pK2hrGGKMurJt` (**verified executable on devnet**). Its `chop_tree` ix uses `#[session_auth_or(...)]`, so a session key can mutate `player_data` with no main-wallet popup. ⚠️ Must fetch the **on-chain IDL** and confirm the deployed revision matches before relying on it (repo `Anchor.toml` only lists localnet).
- **(b) Full token lifecycle (always works, no custom program):** create ephemeral key → `createSession` → inspect the on-chain `SessionToken` PDA (scoped to target + expiry) → sign with session key → `revokeSession` (PDA closed, account gone). This is the dependable core of our demo.
- **(c) CANNOT be demonstrated without deploying a program:** a **custom spend-cap / instruction-scoping rule we control**. The Keysp program stores `valid_until` and (optionally) tops up lamports; it does **not** itself enforce spend caps. Domain-specific gating lives inside the target program via `session_auth_or`.

### Known bug to avoid relying on (source-verified)
- V1 `SessionToken::is_expired` is **inverted** (`now < valid_until`). V2 fixes it. We will NOT build access-control on the V1 validity boolean; we use create → inspect → sign → revoke for the lifecycle demo.

---

## 3. Plan implications

- **`/swig`** — full POC as specified: create Swig, authorize a scoped session (allowed action + SOL spend cap + slot-based expiry), session-key transfers with no popup, **show on-chain rejection** when exceeding cap / past expiry, revoke, activity log. The spend-cap + expiry enforcement is **real and on-chain**.
- **`/magicblock`** — session-token lifecycle (create → inspect on-chain PDA → sign → revoke) as the dependable core, optionally calling `lumberjack.chop_tree` as a real session-gated action. UI carries an **explicit honest note**: this proves the session-key *primitive* and a *third-party* gated action; a *custom* spend-cap rule we control would require deploying a session-aware program (out of scope per constraints).

### Env vars (no secrets committed)
```
NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
NEXT_PUBLIC_SWIG_PROGRAM_ID=swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB
NEXT_PUBLIC_GUM_SESSION_PROGRAM_ID=KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5
NEXT_PUBLIC_LUMBERJACK_PROGRAM_ID=MkabCfyUD6rBTaYHpgKBBpBo5qzWA2pK2hrGGKMurJt
```
Ephemeral session keys live in memory only (Swig) / IndexedDB (Gum SDK). Not production-safe; documented as such.
