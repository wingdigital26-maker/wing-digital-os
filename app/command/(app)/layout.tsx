import { redirect } from "next/navigation";
import { currentUser } from "@/lib/command/auth";
import { personName } from "@/lib/command/team";
import CommandNav from "../_ui/CommandNav";

export const dynamic = "force-dynamic";

// Every Command Center screen sits behind this check (the proxy gate is the
// first line; this is the second). No user, no page.
export default async function CommandShell({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/command/login");
  return (
    <>
      <CommandNav admin={user.admin} name={personName(user.id)} />
      <main className="cc-main">{children}</main>
    </>
  );
}
