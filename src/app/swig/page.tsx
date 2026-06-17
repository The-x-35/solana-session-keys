"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  Actions,
  createEd25519AuthorityInfo,
  createEd25519SessionAuthorityInfo,
  fetchNullableSwig,
  fetchSwig,
  findSwigPda,
  getAddAuthorityInstructions,
  getCreateSessionInstructions,
  getCreateSwigInstruction,
  getSignInstructions,
  getSwigWalletAddress,
} from "@swig-wallet/classic";
import { WalletBar } from "@/components/WalletBar";
import { ActivityLog } from "@/components/ActivityLog";
import { Button, Field, Note, Panel, Step } from "@/components/ui";
import { LogEntry, makeEntry } from "@/lib/activity";
import { buildWalletTx, describeTxError, sendWithKeypair } from "@/lib/solana";
import { addressUrl, shorten } from "@/lib/explorer";

// Solana targets ~400ms/slot. Swig session durations are measured in SLOTS.
const SLOT_MS = 400;
const MAX_SESSION_SLOTS = 1_000_000n; // generous ceiling set at wallet creation
const FEE_FUNDING_LAMPORTS = 0.01 * LAMPORTS_PER_SOL; // tops up the session key for fees

const secondsToSlots = (seconds: number) =>
  BigInt(Math.max(1, Math.ceil((seconds * 1000) / SLOT_MS)));

// Derive the Swig id deterministically from the connected wallet, so the same
// wallet always maps to the same Swig PDA. That makes the wallet rediscoverable
// purely from chain state (fetchNullableSwig) — no localStorage needed. (A Swig
// id is any 32 bytes; a Solana pubkey is exactly 32 bytes.)
const swigIdFor = (owner: PublicKey) => owner.toBytes();

export default function SwigPage() {
  const { connection } = useConnection();
  const { publicKey, connected, signTransaction } = useWallet();

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  // form state
  const [capSol, setCapSol] = useState("0.1");
  const [fundSol, setFundSol] = useState("0.2");
  const [durationSec, setDurationSec] = useState("120");
  const [amountSol, setAmountSol] = useState("0.02");

  // on-chain state
  const [swigId, setSwigId] = useState<Uint8Array | null>(null);
  const [swigAddress, setSwigAddress] = useState<PublicKey | null>(null);
  const [swigWalletAddress, setSwigWalletAddress] = useState<PublicKey | null>(
    null,
  );
  const [sessionKey, setSessionKey] = useState<Keypair | null>(null);
  const [expirySlot, setExpirySlot] = useState<bigint | null>(null);
  const [currentSlot, setCurrentSlot] = useState<number | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [loadedFromStorage, setLoadedFromStorage] = useState(false);
  const [remainingCap, setRemainingCap] = useState<bigint | null>(null);

  const log = useCallback(
    (
      kind: LogEntry["kind"],
      message: string,
      extra?: { signature?: string; address?: string },
    ) => setEntries((prev) => [...prev, makeEntry(kind, message, extra)]),
    [],
  );

  // Load this wallet's Swig directly from chain: derive its deterministic PDA
  // and fetch it. No local storage — if it exists on devnet, it loads.
  const loadFromChain = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      const id = swigIdFor(publicKey);
      const address = findSwigPda(id);
      const swig = await fetchNullableSwig(connection, address);
      if (!swig) {
        log("info", "No Swig wallet found on-chain for this address yet — create one in step 2");
        setSwigId(null);
        setSwigAddress(null);
        setSwigWalletAddress(null);
        setLoadedFromStorage(false);
        return;
      }
      const walletAddress = await getSwigWalletAddress(swig);
      setSwigId(id);
      setSwigAddress(address);
      setSwigWalletAddress(walletAddress);
      setLoadedFromStorage(true);
      log("info", "Loaded your Swig wallet from chain", { address: address.toBase58() });
    } catch (e) {
      log("error", `Load failed: ${describeTxError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [publicKey, connection, log]);

  // Auto-load once per connected address.
  const loadAttemptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!publicKey) return;
    const owner = publicKey.toBase58();
    if (loadAttemptedFor.current === owner) return;
    loadAttemptedFor.current = owner;
    loadFromChain();
  }, [publicKey, loadFromChain]);

  const capLamports = useMemo(
    () => BigInt(Math.round(Number(capSol) * LAMPORTS_PER_SOL)),
    [capSol],
  );

  // Live clock: poll current slot + swig wallet balance so the user can watch
  // the session approach expiry and see funds move.
  const refreshChainState = useCallback(async () => {
    try {
      const slot = await connection.getSlot("confirmed");
      setCurrentSlot(slot);
      if (swigWalletAddress) {
        const bal = await connection.getBalance(swigWalletAddress, "confirmed");
        setWalletBalance(bal / LAMPORTS_PER_SOL);
      }
    } catch {
      /* transient RPC errors are fine */
    }
  }, [connection, swigWalletAddress]);

  useEffect(() => {
    refreshChainState();
    const t = setInterval(refreshChainState, 4000);
    return () => clearInterval(t);
  }, [refreshChainState]);

  const expired = useMemo(() => {
    if (expirySlot === null || currentSlot === null) return false;
    return BigInt(currentSlot) > expirySlot;
  }, [expirySlot, currentSlot]);

  const slotsRemaining = useMemo(() => {
    if (expirySlot === null || currentSlot === null) return null;
    return Number(expirySlot) - currentSlot;
  }, [expirySlot, currentSlot]);

  // Helper: Phantom only SIGNS; we submit through our own (Helius devnet)
  // connection. This avoids the wallet adapter's sendTransaction path (and its
  // cluster detection / opaque "Unexpected error"), guarantees the tx lands on
  // devnet, and surfaces real preflight logs if it fails.
  const sendViaWallet = useCallback(
    async (
      instructions: Parameters<typeof buildWalletTx>[1],
      coSigners: Keypair[] = [],
    ) => {
      if (!publicKey || !signTransaction) {
        throw new Error("Wallet not connected or cannot sign");
      }
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("finalized");
      const tx = new Transaction().add(...instructions);
      tx.feePayer = publicKey;
      tx.recentBlockhash = blockhash;
      if (coSigners.length > 0) tx.partialSign(...coSigners);
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      return sig;
    },
    [connection, publicKey, signTransaction],
  );

  // ── Step 2: create the Swig smart wallet ─────────────────────────────────
  // The root authority is the user's wallet with full control (the deployed
  // program REQUIRES the root role to hold ManageAuthority/All). The scoped,
  // spend-capped *session* authority is added separately at authorize time.
  const createSwigWallet = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      const id = swigIdFor(publicKey); // deterministic → rediscoverable on chain
      const address = findSwigPda(id);

      // Idempotent: if this wallet's Swig already exists on chain, just load it
      // (creating at the same PDA would fail) — so Create is always safe to click.
      const existing = await fetchNullableSwig(connection, address);
      if (existing) {
        const walletAddress = await getSwigWalletAddress(existing);
        setSwigId(id);
        setSwigAddress(address);
        setSwigWalletAddress(walletAddress);
        setLoadedFromStorage(true);
        log("info", "Swig wallet already exists — loaded it from chain", {
          address: address.toBase58(),
        });
        return;
      }

      log("action", "Creating Swig wallet (root authority = your wallet)");
      const ix = await getCreateSwigInstruction({
        payer: publicKey,
        id,
        authorityInfo: createEd25519AuthorityInfo(publicKey),
        actions: Actions.set().all().get(),
      });
      const sig = await sendViaWallet([ix]);

      const swig = await fetchSwig(connection, address);
      const walletAddress = await getSwigWalletAddress(swig);
      setSwigId(id);
      setSwigAddress(address);
      setSwigWalletAddress(walletAddress);
      setSessionKey(null);
      setExpirySlot(null);
      setRemainingCap(null);
      setLoadedFromStorage(true);
      log("success", "Swig wallet created (rediscoverable on-chain anytime)", { signature: sig, address: address.toBase58() });
      log("info", `Fund this wallet address so sessions have SOL to spend: ${shorten(walletAddress.toBase58(), 6)}`, {
        address: walletAddress.toBase58(),
      });
    } catch (e) {
      log("error", `Create failed: ${describeTxError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [publicKey, sendViaWallet, connection, log]);

  // ── Step 3: fund the Swig wallet so the session has SOL to move ──────────
  const fundSwigWallet = useCallback(async () => {
    if (!publicKey || !swigWalletAddress) return;
    setBusy(true);
    try {
      const lamports = Math.round(Number(fundSol) * LAMPORTS_PER_SOL);
      log("action", `Funding Swig wallet with ${fundSol} SOL`);
      const sig = await sendViaWallet([
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: swigWalletAddress,
          lamports,
        }),
      ]);
      log("success", "Swig wallet funded", { signature: sig });
      await refreshChainState();
    } catch (e) {
      log("error", `Funding failed: ${describeTxError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [publicKey, swigWalletAddress, fundSol, sendViaWallet, refreshChainState, log]);

  // ── Step 4: authorize the session ────────────────────────────────────────
  // (1) Add a SEPARATE session-capable authority scoped to ONLY a SOL spend cap
  //     — so the session inherits just the cap (the root keeps full control).
  // (2) Open a time-limited session on that scoped role, bound to a fresh
  //     ephemeral key, and top the session key up for fees.
  // Two approvals: adding the scoped authority, then opening the session.
  const authorizeSession = useCallback(async () => {
    if (!publicKey || !swigAddress) return;
    setBusy(true);
    try {
      const ephemeral = Keypair.generate();
      const durationSlots = secondsToSlots(Number(durationSec));
      log(
        "action",
        `Authorizing session · cap ${capSol} SOL · key ${shorten(ephemeral.publicKey.toBase58(), 6)} · ~${durationSec}s (${durationSlots} slots)`,
      );

      // (1) add the scoped, session-capable authority
      let swig = await fetchSwig(connection, swigAddress);
      const addIxs = await getAddAuthorityInstructions(
        swig,
        0,
        createEd25519SessionAuthorityInfo(publicKey, MAX_SESSION_SLOTS),
        Actions.set().solLimit({ amount: capLamports }).get(),
      );
      const addSig = await sendViaWallet(addIxs);
      log("info", "Added scoped session authority (spend-capped)", { signature: addSig });

      // (2) open a session on the newly added role
      swig = await fetchSwig(connection, swigAddress);
      const scopedRole = [...swig.roles]
        .filter((r) => r.id !== 0 && r.isSessionBased())
        .sort((a, b) => b.id - a.id)[0];
      if (!scopedRole) throw new Error("Scoped session role not found after add");

      const sessionIxs = await getCreateSessionInstructions(
        swig,
        scopedRole.id,
        ephemeral.publicKey,
        durationSlots,
        { payer: publicKey },
      );
      const sig = await sendViaWallet([
        ...sessionIxs,
        // same approval tops up the session key for transaction fees
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: ephemeral.publicKey,
          lamports: FEE_FUNDING_LAMPORTS,
        }),
      ]);

      const refreshed = await fetchSwig(connection, swigAddress);
      const sessionRole = refreshed.findRoleBySessionKey(ephemeral.publicKey);
      if (!sessionRole || !sessionRole.isSessionBased()) {
        throw new Error("Session role not found after creation");
      }
      setSessionKey(ephemeral);
      setExpirySlot(sessionRole.authority.expirySlot);
      setRemainingCap(sessionRole.actions.solSpendLimit());
      log("success", "Session authorized — session key can now act with no pop-ups", {
        signature: sig,
        address: ephemeral.publicKey.toBase58(),
      });
      log(
        "info",
        `Scope: spend ≤ ${capSol} SOL, expires at slot ${sessionRole.authority.expirySlot.toString()}`,
      );
    } catch (e) {
      log("error", `Authorization failed: ${describeTxError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [publicKey, swigAddress, durationSec, capSol, capLamports, connection, sendViaWallet, log]);

  // ── Step 5/6: act within the session, signed only by the session key ─────
  const actViaSession = useCallback(
    async (amountOverride?: number) => {
      if (!publicKey || !swigAddress || !sessionKey || !swigWalletAddress) return;
      setBusy(true);
      const amount = amountOverride ?? Number(amountSol);
      const lamports = BigInt(Math.round(amount * LAMPORTS_PER_SOL));
      try {
        const swig = await fetchSwig(connection, swigAddress);
        const sessionRole = swig.findRoleBySessionKey(sessionKey.publicKey);
        if (!sessionRole) throw new Error("Session role not found (revoked/expired?)");

        // Guard: the Swig wallet must actually hold enough spendable SOL above
        // its rent-exempt reserve — otherwise the failure is a funding issue,
        // not a scope rejection. Pre-check so the message is honest.
        const bal = await connection.getBalance(swigWalletAddress, "confirmed");
        const rentReserve = await connection.getMinimumBalanceForRentExemption(0);
        const spendable = bal - rentReserve;
        if (Number(lamports) > spendable) {
          log(
            "warn",
            `Swig wallet holds ~${(spendable / LAMPORTS_PER_SOL).toFixed(4)} SOL spendable — fund it in step 3 before sending ${amount} SOL (this is a balance issue, not a scope rejection)`,
          );
          return;
        }

        // Client cap-check (the spend-cap policy only — not the balance).
        const withinCap = sessionRole.actions.canSpendSol(lamports);
        log(
          withinCap ? "action" : "warn",
          `Session key sends ${amount} SOL — cap-check: ${
            withinCap ? "within cap" : "EXCEEDS cap"
          } of ${capSol} SOL (the program decides on-chain)`,
        );

        const transferIx = SystemProgram.transfer({
          fromPubkey: swigWalletAddress,
          toPubkey: publicKey, // send back to the user's own wallet
          lamports: Number(lamports),
        });
        const signIxs = await getSignInstructions(
          swig,
          sessionRole.id,
          [transferIx],
          false,
          { payer: sessionKey.publicKey },
        );
        const sig = await sendWithKeypair(connection, signIxs, sessionKey);
        // Refresh the remaining cap — solLimit is a cumulative budget that depletes.
        const post = await fetchSwig(connection, swigAddress);
        const postRole = post.findRoleBySessionKey(sessionKey.publicKey);
        setRemainingCap(postRole ? postRole.actions.solSpendLimit() : null);
        log(
          "success",
          `Transfer succeeded (no wallet pop-up) — ${amount} SOL · cap remaining ${
            postRole ? (Number(postRole.actions.solSpendLimit() ?? 0n) / LAMPORTS_PER_SOL).toFixed(4) : "?"
          } SOL`,
          { signature: sig },
        );
        await refreshChainState();
      } catch (e) {
        const reason = describeTxError(e);
        // Balance was pre-checked above, so a remaining failure is the program
        // enforcing the session's scope (cap/expiry) — unless a race left the
        // wallet short, which we still detect.
        const isBalance = /insufficient lamports|insufficient funds/i.test(reason);
        const note = isBalance
          ? " — Swig wallet is out of SOL; fund it in step 3"
          : " — the session could not exceed its scope (cap/expiry enforced on-chain)";
        log("error", `Rejected by chain: ${reason}${note}`);
      } finally {
        setBusy(false);
      }
    },
    [
      publicKey,
      swigAddress,
      sessionKey,
      swigWalletAddress,
      amountSol,
      capSol,
      connection,
      refreshChainState,
      log,
    ],
  );

  // ── Step 7: revoke — re-open the SCOPED session role with the all-zero key ─
  // The session lives on the scoped role (not root, which isn't session-based),
  // so revoke must target that role.
  const revokeSession = useCallback(async () => {
    if (!publicKey || !swigAddress || !sessionKey) return;
    setBusy(true);
    try {
      const swig = await fetchSwig(connection, swigAddress);
      const sessionRole = swig.findRoleBySessionKey(sessionKey.publicKey);
      if (!sessionRole) throw new Error("Active session role not found");
      const zeroKey = new PublicKey(new Uint8Array(32));
      log("action", "Revoking session (re-opening the scoped role with the all-zero key)");
      const ixs = await getCreateSessionInstructions(swig, sessionRole.id, zeroKey, 1n, {
        payer: publicKey,
      });
      const sig = await sendViaWallet(ixs);
      setSessionKey(null);
      setExpirySlot(null);
      setRemainingCap(null);
      log("success", "Session revoked — the old session key is no longer valid", {
        signature: sig,
      });
    } catch (e) {
      log("error", `Revoke failed: ${describeTxError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [publicKey, swigAddress, sessionKey, connection, sendViaWallet, log]);

  // ── Step 8: reclaim — sweep the Swig wallet balance back via the root ─────
  // Root (role 0) has full control, so it can move funds the session keys left
  // behind. Signed by your wallet. Leaves the rent reserve so the wallet stays
  // usable for future sessions.
  const reclaimViaRoot = useCallback(async () => {
    if (!publicKey || !swigAddress || !swigWalletAddress) return;
    setBusy(true);
    try {
      const bal = await connection.getBalance(swigWalletAddress, "confirmed");
      const rentReserve = await connection.getMinimumBalanceForRentExemption(0);
      const sweep = bal - rentReserve;
      if (sweep <= 0) {
        log("warn", "Nothing to reclaim — Swig wallet holds only its rent reserve");
        return;
      }
      const swig = await fetchSwig(connection, swigAddress);
      const transferIx = SystemProgram.transfer({
        fromPubkey: swigWalletAddress,
        toPubkey: publicKey,
        lamports: sweep,
      });
      // roleId 0 = root (full control); signed by your wallet, no session key.
      const signIxs = await getSignInstructions(swig, 0, [transferIx], false, {
        payer: publicKey,
      });
      log("action", `Reclaiming ${(sweep / LAMPORTS_PER_SOL).toFixed(4)} SOL to your wallet (root-signed)`);
      const sig = await sendViaWallet(signIxs);
      log("success", "Reclaimed Swig wallet balance to your wallet", { signature: sig });
      await refreshChainState();
    } catch (e) {
      log("error", `Reclaim failed: ${describeTxError(e)}`);
    } finally {
      setBusy(false);
    }
  }, [publicKey, swigAddress, swigWalletAddress, connection, sendViaWallet, refreshChainState, log]);

  if (!connected) {
    return (
      <>
        <WalletBar />
        <Panel className="mt-6 text-sm text-zinc-400">
          Connect a devnet wallet to start the Swig demo.
        </Panel>
      </>
    );
  }

  return (
    <>
      <WalletBar />

      <Panel className="mt-6">
        <h2 className="text-lg font-semibold text-white">Swig — smart-wallet session</h2>
        <p className="mt-1 text-sm text-zinc-400">
          The deployed Swig program enforces the spend cap and slot-based expiry.
          The session key is a scoped signer that can never exceed what you
          approve. Run the steps top to bottom.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-zinc-400 sm:grid-cols-3">
          <Stat label="Swig wallet" value={swigWalletAddress ? shorten(swigWalletAddress.toBase58(), 5) : "—"} href={swigWalletAddress ? addressUrl(swigWalletAddress.toBase58()) : undefined} />
          <Stat label="Wallet balance" value={walletBalance === null ? "—" : `${walletBalance.toFixed(3)} SOL`} />
          <Stat
            label="Cap remaining"
            value={remainingCap === null ? "—" : `${(Number(remainingCap) / LAMPORTS_PER_SOL).toFixed(4)} SOL`}
          />
          <Stat label="Session key" value={sessionKey ? shorten(sessionKey.publicKey.toBase58(), 5) : "none"} />
          <Stat
            label="Expiry"
            value={
              expirySlot === null
                ? "—"
                : expired
                  ? "EXPIRED"
                  : `${slotsRemaining} slots (~${Math.max(0, Math.round((slotsRemaining ?? 0) * SLOT_MS / 1000))}s)`
            }
          />
        </div>
      </Panel>

      <Note>
        <strong>How scoping works (verified on devnet).</strong> The deployed
        Swig program requires the <em>root</em> role to hold full authority, so
        the spend cap can&apos;t live on the root. Instead, authorizing a session
        (step 4) adds a <em>separate</em> session-capable authority scoped to{" "}
        <em>only</em> a SOL spend limit, then opens a time-limited session on it.
        The session key inherits just that cap — the program rejects any transfer
        over the cap or after expiry. Authorizing therefore takes two approvals:
        add the scoped authority, then open the session.
      </Note>

      <div className="grid gap-4">
        <Step n={2} title="Create or load the Swig smart wallet" done={!!swigAddress}>
          <p className="text-zinc-400">
            The Swig address is derived from your wallet, so there&apos;s exactly
            one per address and it always loads back from chain — no recreating.
            Create it once (one approval); after that it auto-loads on connect.
          </p>
          {swigAddress && (
            <p className="text-xs text-emerald-300">
              {loadedFromStorage ? "Loaded from chain" : "Active wallet"}:{" "}
              <a className="underline" href={addressUrl(swigWalletAddress!.toBase58())} target="_blank" rel="noreferrer">
                {shorten(swigWalletAddress!.toBase58(), 6)}
              </a>
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <Button onClick={createSwigWallet} disabled={busy}>
              {swigAddress ? "Create / load wallet" : "Create Swig wallet"}
            </Button>
            <Button variant="ghost" onClick={loadFromChain} disabled={busy}>
              {swigAddress ? "Reload from chain" : "Load from chain"}
            </Button>
          </div>
        </Step>

        <Step n={3} title="Fund the Swig wallet" done={!!walletBalance && walletBalance > 0}>
          <p className="text-zinc-400">
            Transfers go <em>out of</em> the Swig wallet, so it needs some SOL.
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Amount" value={fundSol} onChange={setFundSol} suffix="SOL" disabled={busy} />
            <Button onClick={fundSwigWallet} disabled={busy || !swigWalletAddress}>
              Fund wallet
            </Button>
          </div>
        </Step>

        <Step n={4} title="Authorize a session" done={!!sessionKey}>
          <p className="text-zinc-400">
            Adds a scoped, spend-capped session authority and opens a time-limited
            session bound to a fresh ephemeral key. Two approvals.
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Spend cap" value={capSol} onChange={setCapSol} suffix="SOL" disabled={busy} />
            <Field label="Duration" value={durationSec} onChange={setDurationSec} suffix="seconds" disabled={busy} />
            <Button onClick={authorizeSession} disabled={busy || !swigAddress}>
              Authorize session
            </Button>
          </div>
        </Step>

        <Step n={5} title="Act within the session (no pop-up)" done={false}>
          <p className="text-zinc-400">
            The session key signs the transfer — no wallet pop-up. The cap is a
            cumulative budget that depletes as you spend, so transfers succeed
            until their total reaches the cap (watch &quot;Cap remaining&quot;
            above), and only before expiry.
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Transfer amount" value={amountSol} onChange={setAmountSol} suffix="SOL" disabled={busy} />
            <Button onClick={() => actViaSession()} disabled={busy || !sessionKey || expired}>
              Send via session key
            </Button>
          </div>
        </Step>

        <Step n={6} title="Show enforcement">
          <p className="text-zinc-400">
            The session can&apos;t exceed its scope — the chain rejects it.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="ghost"
              onClick={() => actViaSession(Number(capSol) + 0.05)}
              disabled={busy || !sessionKey || expired}
            >
              Try to exceed cap (+0.05 SOL over)
            </Button>
            <Button
              variant="ghost"
              onClick={() => actViaSession()}
              disabled={busy || !sessionKey || !expired}
            >
              Try after expiry
            </Button>
            {expirySlot !== null && (
              <span className="text-xs text-zinc-500">
                {expired ? "session expired — try the action above" : "wait for the expiry countdown to hit 0, then retry"}
              </span>
            )}
          </div>
        </Step>

        <Step n={7} title="Revoke">
          <p className="text-zinc-400">
            Kills the current session key. Funds stay in the Swig wallet — revoke
            and expiry never move balances. You can authorize a new session on the
            same wallet anytime.
          </p>
          <Button variant="danger" onClick={revokeSession} disabled={busy || !sessionKey}>
            Revoke session
          </Button>
        </Step>

        <Step n={8} title="Reclaim funds (root)">
          <p className="text-zinc-400">
            Sweep whatever the sessions left in the Swig wallet back to your
            wallet, signed by your root authority. Leaves the rent reserve so the
            wallet stays usable.
          </p>
          <Button
            variant="ghost"
            onClick={reclaimViaRoot}
            disabled={busy || !swigWalletAddress || !walletBalance}
          >
            Reclaim to my wallet
          </Button>
        </Step>
      </div>

      <ActivityLog entries={entries} />
    </>
  );
}

function Stat({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      {href ? (
        <a className="font-mono text-zinc-200 hover:text-white" href={href} target="_blank" rel="noreferrer">
          {value}
        </a>
      ) : (
        <div className="font-mono text-zinc-200">{value}</div>
      )}
    </div>
  );
}
