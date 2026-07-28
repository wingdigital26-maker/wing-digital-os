import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { isCloud, PC_REQUIRED_BODY } from "@/lib/runtime";

export const runtime = "nodejs";

const AUDIT_DIR = "C:\\Users\\wjack\\Downloads\\wing-audits";

// Must match slug() in audit_pdf_generator.py
function slug(name: string): string {
  let s = [...name.toLowerCase()].map(ch => /[a-z0-9]/.test(ch) ? ch : "-").join("");
  while (s.includes("--")) s = s.replace("--", "-");
  return s.replace(/^-+|-+$/g, "");
}

export async function GET(req: Request) {
  if (isCloud()) {
    // Audit PDFs are generated to a local Downloads folder on Jack's PC.
    return NextResponse.json(PC_REQUIRED_BODY, { status: 503 });
  }
  const { searchParams } = new URL(req.url);
  const name = searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const file = path.join(AUDIT_DIR, `${slug(name)}-audit.pdf`);
  // Guard against path traversal
  if (!file.startsWith(AUDIT_DIR)) return NextResponse.json({ error: "invalid" }, { status: 400 });

  try {
    const buf = await readFile(file);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${slug(name)}-audit.pdf"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Audit PDF not found for this company" }, { status: 404 });
  }
}
