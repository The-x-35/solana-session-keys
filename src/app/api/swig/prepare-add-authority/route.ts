import { NextRequest } from "next/server";
import { checkBearer, bad, fail, ok } from "@/lib/api";
import { prepareAddAuthority } from "@/lib/swig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = checkBearer(req);
  if (denied) return denied;
  try {
    const b = await req.json().catch(() => ({}));
    if (!b.owner) return bad("owner required");
    const cap = b.mint ? b.capAmount : b.capSol;
    if (typeof cap !== "number" || cap <= 0)
      return bad(b.mint ? "capAmount must be a positive number" : "capSol must be a positive number");
    return ok(await prepareAddAuthority(b.owner, cap, b.mint, b.destination));
  } catch (e) {
    return fail(e);
  }
}
