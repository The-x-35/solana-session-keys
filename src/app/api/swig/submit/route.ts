import { NextRequest } from "next/server";
import { checkBearer, bad, fail, ok } from "@/lib/api";
import { submit } from "@/lib/swig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = checkBearer(req);
  if (denied) return denied;
  try {
    const b = await req.json().catch(() => ({}));
    if (!b.signedTxBase64) return bad("signedTxBase64 required");
    return ok(await submit(b.signedTxBase64));
  } catch (e) {
    return fail(e);
  }
}
