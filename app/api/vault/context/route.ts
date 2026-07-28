import { NextResponse } from "next/server";
import { loadPermanentVaultContext } from "@/app/lib/vaultContext";

export async function GET() {
  const content = await loadPermanentVaultContext();
  return NextResponse.json({ content });
}
