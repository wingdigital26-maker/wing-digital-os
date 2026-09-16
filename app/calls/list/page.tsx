import { redirect } from "next/navigation";

// The Dial list and the Today screen were merged into one Call Room (app/calls
// /page.tsx) — the list you work now carries the day's numbers and any owed
// call-backs on top of it. This route is kept only so old links and bookmarks
// to /calls/list land on the merged screen instead of a dead page.
export default function CallListRedirect() {
  redirect("/calls");
}
