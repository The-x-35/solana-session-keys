import { NextRequest } from "next/server";
import { checkBearer, bad, fail, ok } from "@/lib/api";
import { getStatus } from "@/lib/swig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = checkBearer(req);
  if (denied) return denied;
  try {
    const owner = req.nextUrl.searchParams.get("owner");
    const sessionKey = req.nextUrl.searchParams.get("sessionKey") || undefined;
    const mint = req.nextUrl.searchParams.get("mint") || undefined;
    if (!owner) return bad("owner query param required");
    return ok(await getStatus(owner, sessionKey, mint));
  } catch (e) {
    return fail(e);
  }
}
