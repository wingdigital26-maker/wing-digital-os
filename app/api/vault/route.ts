import { NextResponse } from "next/server";
import { listVaultTree, isGithubVault, VAULT_PATH } from "@/lib/vaultSource";

export const runtime = "nodejs";

export async function GET() {
  const tree = await listVaultTree();
  return NextResponse.json({ tree, vault: isGithubVault() ? "github" : VAULT_PATH });
}
