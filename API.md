# Swig Session-Key Helper API

HTTP routes that let the **Avici app** use Solana **Swig** session keys without
running the `@swig-wallet/classic` SDK natively. The server is a pure SDK
**execution layer**: it builds *unsigned* transactions and reads chain state. It
holds **no private keys** and never signs or acts on its own.

Both the SOL and SPL flows were verified end-to-end on **devnet** via
`npm run verify:api` and `npm run verify:api:spl` (build → on-device sign →
submit, including on-chain over-cap rejection and revoke). The
Swig program ID is identical across clusters and is **executable on mainnet**, so
the helper runs on **mainnet** by setting `SOLANA_RPC_URL` to a mainnet endpoint.
Do **not** run `verify:api` against mainnet — it moves real SOL. To re-verify
behavior, point `SOLANA_RPC_URL` at devnet and use a funded devnet keypair.

## Trust / custody model

- **Owner key (root authority)** = the user's Solana key, on the device. Signs
  setup actions (create / fund / add-authority / open-session / revoke / reclaim).
- **Session key** = an ephemeral keypair the **device generates and keeps**. Signs
  only `spend` — no owner approval, no pop-up — and the Swig program rejects
  anything over the cap or after expiry.
- Sessions act on a **separate Swig wallet address** (`walletAddress`), not the
  user's main wallet. The user must **fund** that wallet first; `reclaim` sweeps
  it back. Cap is a cumulative budget that depletes as the session spends.

## SOL vs SPL tokens (e.g. USDC)

Every amount/cap route works two ways:

- **SOL** — omit `mint`; pass SOL amounts as `amountSol` / `capSol`.
- **SPL token** — pass `mint` (the token mint address) plus token amounts as
  `amount` / `capAmount` in **human units** (the server reads the mint's decimals
  and converts; e.g. `amount: 10` of 6-dp USDC = `10000000` base units). Caps use
  Swig `tokenLimit`; transfers use SPL `transferChecked`; recipient/wallet ATAs
  are created idempotently (the fee payer covers the small rent). Classic SPL
  Token program only (not Token-2022).

Both paths are verified end-to-end on devnet (`npm run verify:api`,
`npm run verify:api:spl`), including the on-chain over-cap rejection.

## Auth

Every route requires a shared bearer:

```
Authorization: Bearer <SESSION_HELPER_BEARER>
```

Missing/wrong token → `401`. Set `SESSION_HELPER_BEARER` (and `SOLANA_RPC_URL`)
in the server env.

## Signing contract (what the app does with `txBase64`)

Each `prepare-*` route returns `txBase64` — a serialized **unsigned legacy
`Transaction`** with `feePayer` and a fresh blockhash set. The app:

1. base64-decodes it,
2. signs the message with the right on-device key (the app already has
   `signSolanaTransactionBytes` for exactly this),
3. sends the **signed** base64 back to `POST /api/swig/submit` (or broadcasts via
   its own RPC).

Who signs which tx:

| Route | Signer |
|-------|--------|
| prepare-create, prepare-fund, prepare-add-authority, prepare-open-session, prepare-revoke, prepare-reclaim | **owner** key |
| prepare-spend | **session** key |

Blockhash is `finalized` and valid ~60–90s — sign and submit promptly.

---

## Endpoints

### GET `/api/swig/status?owner=<pubkey>[&sessionKey=<pubkey>]`
Read-only. Does this owner have a Swig wallet; balances; optional session detail.

```jsonc
// no swig yet
{ "exists": false, "swigAddress": "Hi…vc", "currentSlot": 470136739 }

// with ?sessionKey
{
  "exists": true,
  "swigAddress": "Hi…vc",
  "walletAddress": "2Es…tU",
  "walletBalanceSol": 0.28,
  "currentSlot": 470136739,
  "session": {
    "sessionKey": "BHi…Nj", "roleId": 1,
    "active": true, "expired": false,
    "expirySlot": "470137087", "secondsRemaining": 116,
    "capRemainingLamports": "100000000", "capRemainingSol": 0.1
  }
}
```
`session` is `null` if that key is not an active session role (e.g. revoked/expired).

### POST `/api/swig/prepare-create`
Body: `{ "owner": "<pubkey>" }`
- New: `{ "alreadyExists": false, "swigAddress": "…", "txBase64": "…" }` → owner signs → submit.
- Existing (idempotent): `{ "alreadyExists": true, "swigAddress": "…", "walletAddress": "…" }` (no tx).

### POST `/api/swig/prepare-fund`
Body: `{ "owner": "<pubkey>", "amountSol": 0.3 }`
Returns `{ "txBase64": "…", "walletAddress": "…" }`. Owner signs → submit. Moves SOL from the owner into the Swig wallet.

### POST `/api/swig/prepare-add-authority`  *(authorize, step 1 of 2)*
Body: `{ "owner": "<pubkey>", "capSol": 0.1 }`
Adds a separate session-capable authority scoped to **only** a SOL spend cap. Returns `{ "txBase64": "…" }`. Owner signs → submit. **Wait for confirmation before step 2.**

### POST `/api/swig/prepare-open-session`  *(authorize, step 2 of 2)*
Body: `{ "owner": "<pubkey>", "sessionKey": "<device pubkey>", "durationSeconds": 120 }`
Opens a time-limited session on the newest scoped role, bound to the device's session key, and tops that key up with a little SOL for fees. Returns `{ "txBase64": "…", "roleId": 1, "feeFundingLamports": 10000000 }`. Owner signs → submit.

### POST `/api/swig/prepare-spend`
Body: `{ "owner": "<pubkey>", "sessionKey": "<device pubkey>", "to": "<recipient>", "amountSol": 0.02 }`
Returns `{ "txBase64": "…", "feePayer": "<sessionKey>" }`. **Session key signs** → submit. Over cap / after expiry → submit returns `500` with the program error in `logs` (this is the on-chain enforcement, working as intended).

### POST `/api/swig/prepare-revoke`
Body: `{ "owner": "<pubkey>", "sessionKey": "<device pubkey>" }`
Zero-key re-session that kills the session key. Returns `{ "txBase64": "…" }`. Owner signs → submit. (Funds are untouched; expiry also ends a session passively.)

### POST `/api/swig/prepare-reclaim`
Body: `{ "owner": "<pubkey>" }`
Root-signed sweep of the Swig wallet back to the owner (leaves the rent reserve). Returns `{ "txBase64": "…", "sweepSol": 0.28, "walletAddress": "…" }` or `{ "nothingToReclaim": true, "walletAddress": "…" }`. Owner signs → submit.

### POST `/api/swig/submit`
Body: `{ "signedTxBase64": "<app-signed tx>" }`
Broadcasts and confirms. Returns `{ "signature": "…", "confirmed": true }`. On failure returns `500` with `error` and any program `logs`.

---

## Typical app flow

```
prepare-create  → owner sign → submit          (once per user)
prepare-fund    → owner sign → submit          (top up the spending wallet)
prepare-add-authority → owner sign → submit    ┐ authorize a session
prepare-open-session  → owner sign → submit    ┘ (device generates the session key)
prepare-spend   → session sign → submit        (repeat, no pop-up, until cap/expiry)
prepare-revoke  → owner sign → submit          (optional; expiry also ends it)
prepare-reclaim → owner sign → submit          (pull leftover funds back)
```

## Not yet included (next increments)

- **Token-2022 mints.** SPL support targets the classic SPL Token program. A
  Token-2022 mint (transfer fees, etc.) would need the `TOKEN_2022_PROGRAM_ID`
  passed through ATA/transfer instructions.
- **Server-held session keys** (true always-on automation while the app is
  closed). Current design is device-custody: the app holds the session key, so it
  acts pop-up-free while running, but the server cannot spend on its own.
