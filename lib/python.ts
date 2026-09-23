// Finding python from inside the Next dev server.
//
// The server's PATH is not the shell's PATH. A route that shells out to
// "python" can fail with ENOENT on a machine where python is installed and
// resolves fine from a terminal, and the old catch-all handlers turned that
// into HTTP 200 with an empty list: an unreachable database and a genuinely
// empty one looked identical. Try the candidates in order, and only when the
// interpreter itself was not found. A script that actually ran and failed is a
// real error and is rethrown untouched.
//
// Paths use FORWARD SLASHES on purpose; node accepts them on Windows and they
// survive being copied between files without being read as escapes.
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export function pythonCandidates(): string[] {
  return [
    process.env.OS_PYTHON,
    "python",
    "C:/Python314/python.exe",
    "C:/Python313/python.exe",
    "C:/Python312/python.exe",
  ].filter(Boolean) as string[];
}

export class PythonMissingError extends Error {
  constructor(tried: string[]) {
    super(
      `No python interpreter could be started. Tried: ${tried.join(", ")}. ` +
        `Set OS_PYTHON to the full path of python.exe.`
    );
    this.name = "PythonMissingError";
  }
}

type RunOpts = { cwd: string; maxBuffer?: number };

// Run a python script and return its stdout. Throws PythonMissingError when no
// interpreter could be started, or the underlying error when one ran and the
// script failed.
export async function runPython(
  args: string[],
  opts: RunOpts
): Promise<{ stdout: string; interpreter: string }> {
  const tried: string[] = [];
  for (const bin of pythonCandidates()) {
    tried.push(bin);
    try {
      const { stdout } = await execFileAsync(bin, args, {
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      });
      return { stdout, interpreter: bin };
    } catch (e: unknown) {
      // ENOENT means THIS interpreter is not there. Anything else means python
      // ran and the script itself failed, which must surface as-is.
      if ((e as { code?: string })?.code === "ENOENT") continue;
      throw e;
    }
  }
  throw new PythonMissingError(tried);
}
