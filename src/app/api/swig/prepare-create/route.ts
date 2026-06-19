import { NextRequest } from "next/server";
import { checkBearer, bad, fail, ok } from "@/lib/api";
import { prepareCreate } from "@/lib/swig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = checkBearer(req);
  if (denied) return denied;
  try {
    const b = await req.json().catch(() => ({}));
    if (!b.owner) return bad("owner required");
    return ok(await prepareCreate(b.owner));
  } catch (e) {
    return fail(e);
  }
}
