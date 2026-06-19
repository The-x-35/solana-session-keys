import { NextRequest } from "next/server";
import { checkBearer, bad, fail, ok } from "@/lib/api";
import { prepareRevoke } from "@/lib/swig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = checkBearer(req);
  if (denied) return denied;
  try {
    const b = await req.json().catch(() => ({}));
    if (!b.owner) return bad("owner required");
    if (!b.sessionKey) return bad("sessionKey required");
    return ok(await prepareRevoke(b.owner, b.sessionKey));
  } catch (e) {
    return fail(e);
  }
}
