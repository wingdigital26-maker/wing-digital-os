import { NextResponse } from "next/server";
import { pushToAll } from "@/lib/push";

export const runtime = "nodejs";

// Fire a test notification at every registered device (session-gated by middleware).
export async function POST() {
  const res = await pushToAll({
    title: "Wing OS test",
    body: "Push notifications are working on this device.",
    url: "/mission",
    tag: "wing-os-test",
  });
  return NextResponse.json(res);
}
