// Shared runtime-environment helper.
//
// Wing Digital OS was built to run on Jack's local PC, where several routes shell
// out to python / the Claude CLI or read local databases. When the OS is deployed
// to a serverless cloud host (Vercel) none of that exists. Routes that need local
// tools should call isCloud() and degrade gracefully BEFORE attempting a spawn.
//
// Set RUNTIME_ENV=cloud on the hosted deploy. Local dev leaves it unset.

export function isCloud(): boolean {
  return process.env.RUNTIME_ENV === "cloud";
}

// Standard JSON body returned by local-only routes when running in the cloud.
export const PC_REQUIRED_BODY = {
  error: "This action runs local tools and needs the PC online.",
  pcRequired: true,
} as const;
