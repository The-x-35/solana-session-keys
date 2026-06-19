# Solana Session Keys POC — Swig vs MagicBlock/Gum

A devnet proof-of-concept demonstrating **scoped, time-limited session keys** on
Solana, two ways, side by side:

- **`/swig`** — Swig smart-wallet session authorities. The deployed Swig program
  enforces a **SOL spend cap** and a **slot-based expiry** on-chain.
- **`/magicblock`** — MagicBlock / Gum session-key **lifecycle** (create → inspect
  → sign → revoke) using the deployed Gum session program.

> **No custom on-chain program.** This repo deploys nothing. It only calls
> already-deployed programs through their SDKs. Everything is **devnet**.
>
> See [`RESEARCH.md`](./RESEARCH.md) for the Phase-0 findings (verified package
> versions, exact APIs, program IDs, and what each approach can/can't prove).

## Helper API for the Avici app (`/api/swig/*`)

Beyond the two browser demos, this repo exposes **HTTP helper routes** so the
Avici Flutter app can use Swig session keys without running the SDK natively. The
server only **builds unsigned transactions** and reads chain state — it holds no
keys. The app signs on-device (owner key for setup, ephemeral session key for
spends) and submits. Bearer-authed via `SESSION_HELPER_BEARER`.

See [`API.md`](./API.md) for the full contract. Verify end-to-end against devnet:

```bash
npm run dev          # terminal 1
npm run verify:api   # terminal 2 (uses ~/.config/solana/id.json as the device key)
```

## The consent model

A user connects their wallet and **explicitly authorizes a session** scoped to an
allowed action + a spending cap + an expiry, with a single approval. After that an
ephemeral **session key** acts **without further wallet pop-ups** until the session
expires or is revoked. The session key is a *scoped signer* — it can never move
funds the user didn't authorize. Scoping and consent are the whole point.

## Prerequisites

- Node 18+ (developed on Node 24) and npm.
- A browser wallet — **Phantom** or **Solflare** — switched to **devnet**.
- Some **devnet SOL** (faucet link is in the app's top bar, or
  <https://faucet.solana.com/>).

## Setup

```bash
npm install --legacy-peer-deps        # peer ranges across anchor/wallet-adapter
cp .env.local.example .env.local      # all values are public; safe defaults
npm run dev                           # http://localhost:3000
```

`--legacy-peer-deps` is required because the Gum SDK and wallet-adapter pin
overlapping-but-not-identical peer ranges of `@solana/web3.js` / anchor.

### Environment variables (`.env.local`)

All values are **public** (an RPC URL and on-chain program IDs) — there are no
secrets in this app. `.env.local` is gitignored regardless.

| Var | Purpose | Default |
|---|---|---|
| `NEXT_PUBLIC_RPC_URL` | Devnet RPC endpoint | `https://api.devnet.solana.com` |
| `NEXT_PUBLIC_SWIG_PROGRAM_ID` | Swig program (fixed across clusters) | `swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB` |
| `NEXT_PUBLIC_GUM_SESSION_PROGRAM_ID` | Gum session-keys program | `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` |
| `NEXT_PUBLIC_GUM_TARGET_PROGRAM_ID` | Program the Gum session token is scoped to (lifecycle demo) | the Gum program itself |

> The public devnet RPC is heavily rate-limited. For a smooth demo, set
> `NEXT_PUBLIC_RPC_URL` to a free Helius/Triton/QuickNode devnet endpoint.

## Getting devnet SOL

Use the **faucet** link in the top bar, or `https://faucet.solana.com/`, or
`solana airdrop 2 <ADDRESS> --url devnet` from the CLI. You'll spend a little SOL
on rent + fees for the Swig wallet and the Gum session token.

## How to run each demo

### Swig (`/swig`)
1. Connect your devnet wallet.
2. **Create the Swig wallet** — set the session spend cap (the cap is bound to the
   wallet authority; sessions inherit it). *One approval.*
3. **Fund the Swig wallet** — transfers go out of it, so it needs some SOL.
4. **Authorize a session** — set a duration; this generates an ephemeral session
   key and opens a time-limited session bound to it, and tops the session key up
   for fees. *One approval — the consent signature.*
5. **Act** — the session key sends a transfer with **no pop-up**, succeeding only
   within the cap and before expiry.
6. **Show enforcement** — try to exceed the cap, or wait for the expiry countdown
   and try again; the **chain rejects** it.
7. **Revoke** — invalidates the session key.

### MagicBlock / Gum (`/magicblock`)
1. Connect your devnet wallet.
2. **Create the session** — generates an ephemeral key and an on-chain
   `SessionToken` PDA scoped to the target program with an expiry. *One approval.*
3. **Inspect** — decodes the on-chain token: owner program, authority, scope, and
   expiry.
4. **Sign** — the session key signs a message with **no owner pop-up**.
5. **Revoke** — closes the token account; re-inspect to confirm it's gone.

## Swig vs MagicBlock/Gum — comparison

| | **Swig** | **MagicBlock / Gum** |
|---|---|---|
| Package | `@swig-wallet/classic@2.1.0` | `@magicblock-labs/gum-react-sdk@3.0.10` + `gum-sdk@3.0.10` |
| Devnet program | `swigyp…dbQMB` | `Keysp…bwde5` |
| Model | Smart wallet with roles/authorities; a **session authority** inherits a role's scoped actions | A **SessionToken** PDA tying an ephemeral key to a target program + expiry |
| **Spend cap enforced on-chain?** | ✅ Yes — the Swig program rejects transfers over `solLimit`/`tokenLimit` | ❌ Not by the session program — gating lives in the *target* program |
| **Expiry enforced on-chain?** | ✅ Yes — slot-based, program-enforced | ✅ Stored on-chain (`validUntil`); checked by the target program |
| Session key signs w/o owner pop-up | ✅ | ✅ |
| Revoke | ✅ Re-open session with the all-zero key | ✅ `revokeSession` closes the token PDA |
| Funds demo with **no custom program** | ✅ Full: real spend-capped, time-limited SOL transfers | ⚠️ Lifecycle only; a real fund/state gate needs a session-aware target program |
| Where it fits best | Apps that want an on-chain-enforced, scoped spending wallet out of the box | Apps that already run their own program and want gas-free, pop-up-free session UX gated by their program |
| Maintenance (as of 2026-06) | Actively developed | Program active; published JS SDK thinly maintained (single maintainer) |

**Bottom line:** for *this* use case — a session that the chain itself prevents
from exceeding a spend cap, with no custom program — **Swig** is the complete
demo. **Gum** cleanly demonstrates the session-key *primitive* (scoped on-chain
token + ephemeral signer + revoke); enforcing a custom spend cap with Gum requires
deploying a session-aware program, which this POC deliberately avoids.

## Security & production notes

- **Devnet only. No real funds.**
- Ephemeral session keys are **never persisted by this app**. Swig's key lives in
  React memory for the page session; the Gum SDK stores its key encrypted in the
  browser's IndexedDB. **Neither is production-safe** — a learning/demo artifact.
- No secrets or keypairs are committed. `.env.local` holds only public values and
  is gitignored.
- The session keypair pays its own transaction fees (Swig), so it's topped up with
  a small amount during authorization.

## Verified on devnet

Both flows have been executed end-to-end against **real devnet** (not just type-
checked). The headless scripts reproduce the exact on-chain calls the UI makes:

```bash
npm run verify:swig   # createSwig → scoped session authority → in-cap transfer
                      # (succeeds) → over-cap transfer (rejected on-chain) → revoke
npm run verify:gum    # createSession → inspect on-chain SessionToken → sign → revoke
```

They fund from your local Solana CLI keypair (`~/.config/solana/id.json`, override
with `KEYPAIR_PATH=...`) because the public faucet is rate-limited. They spend only
**valueless devnet test SOL** (a few thousandths, for rent + fees). Each step prints
a transaction signature you can open on Solana Explorer with `?cluster=devnet`.

> Running `verify:swig` is what surfaced that Swig&apos;s **root role must hold
> `ManageAuthority`/`All`** — a scoped-only root is rejected on-chain. The app and
> `RESEARCH.md` use the corrected two-role design (full-control root + a separate
> `solLimit`-scoped session authority).

## Scripts

```bash
npm run dev          # dev server
npm run build        # production build
npm run typecheck    # tsc --noEmit
npm run lint         # next lint
npm run verify:swig  # devnet end-to-end Swig proof (uses local CLI keypair)
npm run verify:gum   # devnet Gum session-token lifecycle proof
```

## Project layout

```
src/
  app/
    page.tsx              # overview + consent model
    swig/page.tsx         # Swig demo (scoped session, on-chain cap + expiry)
    magicblock/page.tsx   # Gum session-token lifecycle
  components/             # WalletProviders, WalletBar, ActivityLog, NavTabs, ui
  lib/                    # env, explorer links, tx helpers, activity types
RESEARCH.md               # Phase-0 verified findings
```
