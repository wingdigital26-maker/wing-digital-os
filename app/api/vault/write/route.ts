import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { VAULT_PATH as VAULT } from "@/lib/vaultSource";

export const runtime = "nodejs";

const FORBIDDEN = ["raw"]; // never write to raw/

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { filePath, content } = body as { filePath?: unknown; content?: unknown };
  if (typeof filePath !== "string" || !filePath || typeof content !== "string") {
    return NextResponse.json({ error: "filePath and string content required" }, { status: 400 });
  }

  const abs = path.resolve(VAULT, filePath);

  // Security: must stay inside vault (exact match or a real subpath, so a
  // sibling dir like "<vault>-other" cannot pass a bare prefix check).
  if (abs !== VAULT && !abs.startsWith(VAULT + path.sep)) {
    return NextResponse.json({ error: "Path outside vault" }, { status: 403 });
  }

  // Never write to raw/
  const rel = path.relative(VAULT, abs);
  if (FORBIDDEN.some(f => rel.startsWith(f))) {
    return NextResponse.json({ error: "Cannot write to raw/" }, { status: 403 });
  }

  // Ensure directory exists
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");

  return NextResponse.json({ ok: true, path: rel });
}
