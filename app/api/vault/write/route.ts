import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const VAULT = "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";
const FORBIDDEN = ["raw"]; // never write to raw/

export async function POST(req: NextRequest) {
  const { filePath, content } = await req.json();
  if (!filePath || content === undefined) {
    return NextResponse.json({ error: "filePath and content required" }, { status: 400 });
  }

  const abs = path.join(VAULT, filePath);

  // Security: must stay inside vault
  if (!abs.startsWith(VAULT)) {
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
