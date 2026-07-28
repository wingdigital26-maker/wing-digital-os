import { NextRequest, NextResponse } from "next/server";
import { readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "No path" }, { status: 400 });

  // Reject path traversal before hitting the source.
  if (filePath.includes("..")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 403 });
  }

  const content = await readVaultFile(filePath);
  if (content === null) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  return NextResponse.json({ content, path: filePath });
}
