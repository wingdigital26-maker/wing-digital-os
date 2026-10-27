// The Wing team, as the Command Center knows it. Names and jobs only: phone
// numbers and login codes live in env vars, never in code or the vault.
// Importable from client components (no server-only imports here).

export type PersonId = "jack" | "grant" | "dylan" | "pansh";
export type UserId = "jack" | "grant" | "dylan";

export type Person = {
  id: PersonId;
  name: string;
  /** Can sign in to the Command Center. Pansh is paid per site and does not. */
  login: boolean;
  role: "admin" | "member" | "contractor";
  does: string[];
  weekly: string[];
};

export const TEAM: Person[] = [
  {
    id: "jack",
    name: "Jack",
    login: true,
    role: "admin",
    does: ["Builds the software and new products", "Roof Command, the OS, the agents", "Signs new clients"],
    weekly: ["Problems fixed", "Deals moved forward"],
  },
  {
    id: "grant",
    name: "Grant",
    login: true,
    role: "member",
    does: [
      "Runs Wing's own email outreach (Instantly)",
      "Runs Wing's own text outreach (Twilio)",
      "Checks the software each week and reports problems",
    ],
    weekly: ["Emails sent", "Replies", "Meetings booked"],
  },
  {
    id: "dylan",
    name: "Dylan",
    login: true,
    role: "member",
    does: [
      "Cold calls roofers",
      "Keeps a weekly check-in with every signed roofer",
      "Reports roofer problems",
    ],
    weekly: ["Calls made", "Meetings booked", "Check-ins done", "At-risk roofers"],
  },
  {
    id: "pansh",
    name: "Pansh",
    login: false,
    role: "contractor",
    does: ["Builds client websites, paid per site"],
    weekly: ["Sites delivered on time"],
  },
];

export const USERS: UserId[] = ["jack", "grant", "dylan"];

export function personName(id: string | null | undefined): string {
  if (!id) return "Nobody";
  return TEAM.find((p) => p.id === id)?.name ?? id;
}
