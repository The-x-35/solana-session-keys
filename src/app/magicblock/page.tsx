"use client";

import { useCallback, useMemo, useState } from "react";
import {
  useAnchorWallet,
  useConnection,
  useWallet,
  type AnchorWallet,
} from "@solana/wallet-adapter-react";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  useSessionKeyManager,
  type SessionWalletInterface,
} from "@magicblock-labs/gum-react-sdk";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";
import bs58 from "bs58";
import { WalletBar } from "@/components/WalletBar";
import { ActivityLog } from "@/components/ActivityLog";
import { Button, Field, Note, Panel, Step } from "@/components/ui";
import { LogEntry, makeEntry } from "@/lib/activity";
import {
  GUM_SESSION_PROGRAM_ID,
  GUM_TARGET_PROGRAM_ID,
} from "@/lib/env";
import { addressUrl, shorten } from "@/lib/explorer";

export default function MagicBlockPage() {
  const { connected } = useWallet();
  const anchorWallet = useAnchorWallet();

  return (
    <>
      <WalletBar />
      {connected && anchorWallet ? (
        <GumDemo wallet={anchorWallet} />
      ) : (
        <Panel className="mt-6 text-sm text-zinc-400">
          Connect a devnet wallet to start the MagicBlock / Gum demo.
        </Panel>
      )}
    </>
  );
}

interface DecodedToken {
  authority: string;
  targetProgram: string;
  sessionSigner: string;
  validUntil: number; // unix seconds
  owner: string;
}

interface PrevSession {
  token: string;
  target: string;
  signer: string;
  validUntil: number; // unix seconds
}

function GumDemo({ wallet }: { wallet: AnchorWallet }) {
  const { connection } = useConnection();
  const session: SessionWalletInterface = useSessionKeyManager(
    wallet,
    connection,
    "devnet",
  );

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [expiryMinutes, setExpiryMinutes] = useState("60");
  const [topUpSol, setTopUpSol] = useState("0.01");
  const [transferSol, setTransferSol] = useState("0.002");
  const [message, setMessage] = useState("I authorize this session action");
  const [decoded, setDecoded] = useState<DecodedToken | null>(null);
  const [prevSessions, setPrevSessions] = useState<PrevSession[] | null>(null);

  const log = useCallback(
    (
      kind: LogEntry["kind"],
      msg: string,
      extra?: { signature?: string; address?: string },
    ) => setEntries((prev) => [...prev, makeEntry(kind, msg, extra)]),
    [],
  );

  // Manager used only to decode/inspect the on-chain SessionToken account.
  const tokenManager = useMemo(
    () =>
      new SessionTokenManager(
        wallet as unknown as ConstructorParameters<typeof SessionTokenManager>[0],
        connection as Connection,
      ),
    [wallet, connection],
  );

  // ── Step 2: create the session ──────────────────────────────────────────
  // Generates an ephemeral keypair and creates an on-chain SessionToken PDA
  // scoped to the target program with an expiry. One wallet approval.
  const createSession = useCallback(async () => {
    if (!session.createSession) return;
    setBusy(true);
    try {
      const minutes = Math.min(24 * 60, Math.max(1, Number(expiryMinutes)));
      const topUpLamports = Math.max(0, Math.round(Number(topUpSol) * LAMPORTS_PER_SOL));
      log(
        "action",
        `Creating session · target ${shorten(GUM_TARGET_PROGRAM_ID.toBase58(), 5)} · expires in ${minutes} min · top-up ${topUpSol} SOL`,
      );
      // topUpLamports > 0 funds the ephemeral key (from your wallet) so it can
      // pay fees and sign its OWN transactions in step 4.
      const result = await session.createSession(
        GUM_TARGET_PROGRAM_ID,
        topUpLamports,
        minutes,
      );
      const token = result?.sessionToken ?? session.sessionToken;
      if (!token) throw new Error("No session token returned");
      log("success", "Session created — on-chain SessionToken PDA exists", {
        address: token,
      });
      log(
        "info",
        `Ephemeral session signer: ${session.publicKey?.toBase58() ?? "(pending)"}`,
        { address: session.publicKey?.toBase58() },
      );
    } catch (e) {
      log("error", `Create failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [session, expiryMinutes, topUpSol, log]);

  // ── Step 3: inspect the on-chain token ──────────────────────────────────
  const inspect = useCallback(async () => {
    const token = session.sessionToken;
    if (!token) {
      log("warn", "No session token to inspect — create one first");
      return;
    }
    setBusy(true);
    try {
      const tokenPk = new PublicKey(token);
      const info = await connection.getAccountInfo(tokenPk, "confirmed");
      if (!info) {
        setDecoded(null);
        log("warn", "SessionToken account not found on-chain (closed/expired?)");
        return;
      }
      const data = await tokenManager.get(tokenPk);
      const d: DecodedToken = {
        authority: data.authority.toBase58(),
        targetProgram: data.targetProgram.toBase58(),
        sessionSigner: data.sessionSigner.toBase58(),
        validUntil: data.validUntil.toNumber(),
        owner: info.owner.toBase58(),
      };
      setDecoded(d);
      const ownedByGum = info.owner.equals(GUM_SESSION_PROGRAM_ID);
      log(
        ownedByGum ? "success" : "warn",
        `Decoded SessionToken · scoped to target ${shorten(d.targetProgram, 5)} · owned by ${ownedByGum ? "Gum session program ✓" : shorten(d.owner, 5)}`,
        { address: token },
      );
    } catch (e) {
      log("error", `Inspect failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [session.sessionToken, connection, tokenManager, log]);

  // ── Step 4a: sign a message with the session key (OFF-CHAIN, no tx) ───────
  const signWithSession = useCallback(async () => {
    if (!session.signMessage) {
      log("warn", "No active session — create one first");
      return;
    }
    setBusy(true);
    try {
      log("action", "Signing a message with the session key (off-chain, no pop-up)");
      const sig = await session.signMessage(new TextEncoder().encode(message));
      log(
        "success",
        `Off-chain signature by session key ${shorten(session.publicKey?.toBase58() ?? "", 5)}: ${shorten(bs58.encode(sig), 8)} (not a transaction — nothing to open on Explorer)`,
      );
    } catch (e) {
      log("error", `Signing failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [session, message, log]);

  // ── Step 4b: send a REAL on-chain transfer signed only by the session key ─
  // Moves the session key's OWN topped-up SOL (back to your wallet). Proves the
  // session key signs & submits transactions with no owner pop-up — and gives a
  // tx you can open on Explorer. NOTE: this spends the ephemeral key's own
  // balance, not your main wallet's funds; gating your wallet's funds via the
  // session token would require a session-aware target program (out of scope).
  const transferViaSession = useCallback(async () => {
    if (!session.sendTransaction || !session.publicKey) {
      log("warn", "No active session — create one first (with a top-up so the key has SOL)");
      return;
    }
    setBusy(true);
    try {
      const lamports = Math.round(Number(transferSol) * LAMPORTS_PER_SOL);
      const bal = await connection.getBalance(session.publicKey, "confirmed");
      if (bal < lamports + 5000) {
        log(
          "warn",
          `Session key holds ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL — create a session with a larger top-up to send ${transferSol} SOL`,
        );
        return;
      }
      log("action", `Session key sends ${transferSol} SOL (its own balance) — no owner pop-up`);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: session.publicKey,
          toPubkey: wallet.publicKey,
          lamports,
        }),
      );
      const sig = await session.sendTransaction(tx, connection);
      log("success", `On-chain transfer signed by the session key — ${transferSol} SOL`, {
        signature: sig,
      });
    } catch (e) {
      log("error", `Transfer failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [session, transferSol, connection, wallet.publicKey, log]);

  // ── Step 5: revoke ───────────────────────────────────────────────────────
  const revoke = useCallback(async () => {
    if (!session.revokeSession) return;
    setBusy(true);
    try {
      const token = session.sessionToken;
      log("action", "Revoking session — closing the SessionToken account");
      const sig = await session.revokeSession();
      setDecoded(null);
      log(
        "success",
        "Session revoked — token account closed, the session key is no longer valid",
        { signature: sig ?? undefined, address: token ?? undefined },
      );
    } catch (e) {
      log("error", `Revoke failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [session, log]);

  // ── Step 6: discover all SessionTokens on-chain where you are the authority ─
  // Queries by memcmp on the authority field (offset 8). Finds sessions created
  // earlier — even in another browser/origin where the local key is long gone.
  const loadSessions = useCallback(async () => {
    setBusy(true);
    try {
      const accts = await tokenManager.program.account.sessionToken.all([
        { memcmp: { offset: 8, bytes: wallet.publicKey.toBase58() } },
      ]);
      const list: PrevSession[] = accts.map((a) => {
        const acc = a.account as {
          targetProgram: PublicKey;
          sessionSigner: PublicKey;
          validUntil: { toNumber(): number };
        };
        return {
          token: a.publicKey.toBase58(),
          target: acc.targetProgram.toBase58(),
          signer: acc.sessionSigner.toBase58(),
          validUntil: acc.validUntil.toNumber(),
        };
      });
      setPrevSessions(list);
      log("info", `Found ${list.length} session token(s) on-chain for your wallet`);
    } catch (e) {
      log("error", `Load sessions failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [tokenManager, wallet.publicKey, log]);

  // Revoke ANY of your session tokens (authority-signed) → closes it and
  // reclaims its rent to your wallet. The current SDK revoke (step 5) also sweeps
  // the live session key's leftover SOL; old keys' top-ups can't be swept (key
  // gone), so only their rent is reclaimable here.
  const revokeToken = useCallback(
    async (tokenStr: string) => {
      setBusy(true);
      try {
        log("action", `Revoking ${shorten(tokenStr, 5)} (reclaims rent to your wallet)`);
        const sig = await tokenManager.program.methods
          .revokeSession()
          .accounts({
            sessionToken: new PublicKey(tokenStr),
            authority: wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        log("success", "Revoked — token closed, rent reclaimed to you", {
          signature: sig,
          address: tokenStr,
        });
        await loadSessions();
      } catch (e) {
        log("error", `Revoke failed: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [tokenManager, wallet.publicKey, loadSessions, log],
  );

  return (
    <>
      <Panel className="mt-6">
        <h2 className="text-lg font-semibold text-white">
          MagicBlock / Gum — session-key lifecycle
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Create an ephemeral key and a real on-chain <code>SessionToken</code>{" "}
          scoped to a target program with an expiry, sign with the session key,
          then revoke. Uses the deployed Gum session program — nothing custom.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-zinc-400 sm:grid-cols-3">
          <Stat
            label="Session token"
            value={session.sessionToken ? shorten(session.sessionToken, 5) : "none"}
            href={session.sessionToken ? addressUrl(session.sessionToken) : undefined}
          />
          <Stat
            label="Session signer"
            value={session.publicKey ? shorten(session.publicKey.toBase58(), 5) : "—"}
          />
          <Stat
            label="Expires"
            value={
              decoded ? new Date(decoded.validUntil * 1000).toLocaleTimeString() : "—"
            }
          />
        </div>
      </Panel>

      <Note>
        <strong>What this proves vs. what it doesn&apos;t.</strong> This demo
        exercises the session-key <em>primitive</em> end-to-end on devnet: an
        on-chain token scoped to a target program, with an expiry, created and
        revoked by the deployed Gum program, plus signing by the ephemeral key
        with no owner pop-up — including a real on-chain transfer of the session
        key&apos;s <em>own</em> topped-up balance. What it does <strong>not</strong>{" "}
        do: move <em>your main wallet&apos;s</em> funds via the token, or enforce a
        spend cap. The Gum program stores only scope + expiry and leaves
        fund/state gating to the <em>target</em> program (via{" "}
        <code>session_auth_or</code>); a session key cannot touch your wallet&apos;s
        balance without a session-aware program validating the token — which this
        POC deliberately avoids. For a session key that spends <em>your</em> funds
        under an on-chain cap with no custom program, see the Swig tab.
      </Note>

      <div className="grid gap-4">
        <Step n={2} title="Create the session" done={!!session.sessionToken}>
          <p className="text-zinc-400">
            The top-up funds the ephemeral key (from your wallet) so it can sign &
            pay for its own transactions in step 4.
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <Field
              label="Expiry"
              value={expiryMinutes}
              onChange={setExpiryMinutes}
              suffix="minutes (max 1440)"
              disabled={busy}
            />
            <Field
              label="Top-up"
              value={topUpSol}
              onChange={setTopUpSol}
              suffix="SOL"
              disabled={busy}
            />
            <Button onClick={createSession} disabled={busy || session.isLoading}>
              Create session
            </Button>
          </div>
        </Step>

        <Step n={3} title="Inspect the on-chain token">
          <p className="text-zinc-400">
            Reads the <code>SessionToken</code> account and decodes it: owner,
            scope (target program), session signer, and expiry.
          </p>
          <Button
            variant="ghost"
            onClick={inspect}
            disabled={busy || !session.sessionToken}
          >
            Inspect token
          </Button>
          {decoded && (
            <dl className="mt-2 grid grid-cols-1 gap-1 rounded-lg border border-white/10 bg-black/20 p-3 font-mono text-[11px] text-zinc-300">
              <Row k="owner program" v={decoded.owner} />
              <Row k="authority (you)" v={decoded.authority} />
              <Row k="target program (scope)" v={decoded.targetProgram} />
              <Row k="session signer" v={decoded.sessionSigner} />
              <Row
                k="valid until"
                v={new Date(decoded.validUntil * 1000).toISOString()}
              />
            </dl>
          )}
        </Step>

        <Step n={4} title="Act with the session key (no owner pop-up)">
          <p className="text-zinc-400">
            Two ways the ephemeral key acts on its own — neither prompts your main
            wallet. The message signature is <em>off-chain</em> (no Explorer link);
            the transfer is a <em>real on-chain transaction</em> you can open.
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <Field
              label="Message"
              value={message}
              onChange={setMessage}
              disabled={busy}
            />
            <Button
              variant="ghost"
              onClick={signWithSession}
              disabled={busy || !session.sessionToken}
            >
              Sign message (off-chain)
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <Field
              label="Transfer (session key's own SOL → you)"
              value={transferSol}
              onChange={setTransferSol}
              suffix="SOL"
              disabled={busy}
            />
            <Button
              onClick={transferViaSession}
              disabled={busy || !session.sessionToken}
            >
              Send transfer (on-chain)
            </Button>
          </div>
        </Step>

        <Step n={5} title="Revoke">
          <p className="text-zinc-400">
            Closes the token account. Re-run <em>Inspect</em> afterward to confirm
            it&apos;s gone.
          </p>
          <Button
            variant="danger"
            onClick={revoke}
            disabled={busy || !session.sessionToken}
          >
            Revoke session
          </Button>
        </Step>

        <Step n={6} title="Previous sessions (on-chain) & reclaim">
          <p className="text-zinc-400">
            Discover every <code>SessionToken</code> on devnet where your wallet is
            the authority — including ones created earlier whose local key is gone.
            Revoke any to close it and reclaim its rent to your wallet.
          </p>
          <Button variant="ghost" onClick={loadSessions} disabled={busy}>
            Load my sessions from chain
          </Button>
          {prevSessions && prevSessions.length === 0 && (
            <p className="text-xs text-zinc-500">No open session tokens for your wallet.</p>
          )}
          {prevSessions && prevSessions.length > 0 && (
            <ul className="mt-2 space-y-2">
              {prevSessions.map((s) => {
                const expired = s.validUntil * 1000 < Date.now();
                return (
                  <li
                    key={s.token}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px]"
                  >
                    <div className="font-mono text-zinc-300">
                      <a className="text-purple-300 hover:text-purple-200" href={addressUrl(s.token)} target="_blank" rel="noreferrer">
                        {shorten(s.token, 6)}
                      </a>
                      <span className="ml-2 text-zinc-500">
                        signer {shorten(s.signer, 5)} · {expired ? "expired" : "valid"} until{" "}
                        {new Date(s.validUntil * 1000).toLocaleString()}
                      </span>
                    </div>
                    <Button variant="danger" onClick={() => revokeToken(s.token)} disabled={busy}>
                      Revoke &amp; reclaim
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Step>
      </div>

      <ActivityLog entries={entries} />
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-zinc-500">{k}</span>
      <a
        className="text-purple-300 hover:text-purple-200"
        href={addressUrl(v)}
        target="_blank"
        rel="noreferrer"
      >
        {shorten(v, 6)}
      </a>
    </div>
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
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      {href ? (
        <a
          className="font-mono text-zinc-200 hover:text-white"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {value}
        </a>
      ) : (
        <div className="font-mono text-zinc-200">{value}</div>
      )}
    </div>
  );
}
