import { NextRequest, NextResponse } from "next/server";

export function ok(data: unknown) {
  return NextResponse.json(data);
}

export function bad(reason: string) {
  return NextResponse.json({ error: reason }, { status: 400 });
}

export function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export function fail(e: unknown) {
  const err = e as { message?: string; logs?: string[] };
  return NextResponse.json(
    { error: err?.message || String(e), logs: err?.logs ?? undefined },
    { status: 500 },
  );
}

export function checkBearer(req: NextRequest): NextResponse | null {
  const expected = process.env.SESSION_HELPER_BEARER?.trim();
  if (!expected) {
    return NextResponse.json(
      { error: "SESSION_HELPER_BEARER not configured on server" },
      { status: 500 },
    );
  }
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token !== expected) return unauthorized();
  return null;
}
