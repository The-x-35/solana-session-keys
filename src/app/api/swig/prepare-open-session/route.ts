import { NextRequest } from "next/server";
import { checkBearer, bad, fail, ok } from "@/lib/api";
import { prepareOpenSession } from "@/lib/swig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = checkBearer(req);
  if (denied) return denied;
  try {
    const b = await req.json().catch(() => ({}));
    if (!b.owner) return bad("owner required");
    if (!b.sessionKey) return bad("sessionKey (the device-held ephemeral pubkey) required");
    if (typeof b.durationSeconds !== "number" || b.durationSeconds <= 0)
      return bad("durationSeconds must be a positive number");
    return ok(
      await prepareOpenSession(b.owner, b.sessionKey, b.durationSeconds),
    );
  } catch (e) {
    return fail(e);
  }
}
