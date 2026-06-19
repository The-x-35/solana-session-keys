import { NextRequest } from "next/server";
import { checkBearer, bad, fail, ok } from "@/lib/api";
import { prepareSpend } from "@/lib/swig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = checkBearer(req);
  if (denied) return denied;
  try {
    const b = await req.json().catch(() => ({}));
    if (!b.owner) return bad("owner required");
    if (!b.sessionKey) return bad("sessionKey required");
    if (!b.to) return bad("to (recipient pubkey) required");
    const amount = b.mint ? b.amount : b.amountSol;
    if (typeof amount !== "number" || amount <= 0)
      return bad(b.mint ? "amount must be a positive number" : "amountSol must be a positive number");
    return ok(await prepareSpend(b.owner, b.sessionKey, b.to, amount, b.mint));
  } catch (e) {
    return fail(e);
  }
}
