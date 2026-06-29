import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const VAULT = "C:\\Users\\wjack\\OneDrive\\Documentos\\Obsidian 2.0\\Jacks Ai Brain 2.0";

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "No path" }, { status: 400 });

  const fullPath = path.join(VAULT, filePath);

  // Security: make sure path stays inside vault
  if (!fullPath.startsWith(VAULT)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  try {
    const content = fs.readFileSync(fullPath, "utf-8");
    return NextResponse.json({ content, path: filePath });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
