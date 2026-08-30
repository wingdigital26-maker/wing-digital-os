import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

// Lecture summarizer. Called by the class schedule app after Jack records /
// types notes in a lecture. The app previously "summarized" by keyword-ranking
// sentences Jack already wrote -- this puts a real model behind it.
//
// Auth: Bearer LECTURE_API_SECRET. Same bearer convention as the schedule push
// route, but a DIFFERENT env var on purpose: this key must not be able to fire
// pushes, and SCHEDULE_PUSH_SECRET must not be able to spend Anthropic tokens.
//
// The whole point of this endpoint is NOT fabricating. It summarizes only what
// is in the notes. It never returns an invented fallback summary: if the model
// call fails, the caller gets an honest error to put on screen.

const MODEL = "claude-opus-5";
const MAX_CHARS = 60_000; // ~15k tokens of lecture. Beyond this we refuse, never truncate.

type Body = {
  course?: unknown;
  date?: unknown;
  notes?: unknown;
  transcript?: unknown;
};

export type LectureSummary = {
  headline: string;
  keyPoints: string[];
  terms: { term: string; definition: string }[];
  todos: { text: string; due?: string }[];
  questions: string[];
  confidence: "high" | "low";
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.LECTURE_API_SECRET;
  if (!secret) return false; // fail CLOSED: no key configured => nobody gets in
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

const SYSTEM = `You summarize a single university lecture from the student's own raw notes, and (when present) a machine speech-to-text transcript of the same lecture. The student is Jack. Your output is read as if it were his notes, so it has to be true to them.

THE ONE RULE THAT MATTERS MOST: summarize ONLY what is present in the provided notes and transcript. You must not add outside knowledge about the subject. You must not fill gaps with what a lecture on this topic would usually cover. You must not invent a term, a definition, a date, a deadline, an assignment, a name, or a number that does not appear in the input. Sparse notes must produce a sparse summary. Two words of input produce almost nothing, and that is the correct answer. A confidently wrong exam date here would cost Jack a grade, so an empty array is always better than a plausible guess.

Field rules:
- headline: one short line naming what this lecture was about, drawn from the input. If the input does not say what the lecture was about, describe only what is literally there (e.g. "Fragmentary note: 'entropy increases'"). Never title it with a topic the notes do not name.
- keyPoints: the substantive points the notes actually make, most important first. Compress and clarify Jack's shorthand, but do not extend it. If the notes contain no substantive point, return an empty array.
- terms: only terms whose definition is stated in the notes or transcript. A term mentioned without a definition does NOT belong here. Never supply a definition from your own knowledge.
- todos: only things Jack must go and do that are stated in the input -- readings, problem sets, exam or due dates said aloud. Copy dates exactly as stated; never normalize a vague date into a specific one and never infer one. Omit "due" when no date was given.
- questions: the highest-value field. Real gaps only -- places where the notes are ambiguous, contradictory, cut off mid-thought, reference something never explained, or record a conclusion without its reasoning. Each question must be traceable to something actually in the notes. Do not generate study-guide filler, generic review prompts, or questions about material the lecture never touched. If the notes are clear, or too thin to even have identifiable gaps, return fewer questions or none.
- confidence: "high" only when the input is substantial enough that the summary genuinely reflects the lecture. Use "low" whenever the input is short, fragmentary, garbled, or covers only part of a session -- the app shows the student a warning when this is "low".

Write plainly. No em dashes. Do not pad any field to look thorough.`;

function buildPrompt(course: string, date: string, notes: string, transcript: string): string {
  const parts: string[] = [];
  parts.push(`Course: ${course || "(not provided)"}`);
  parts.push(`Date: ${date || "(not provided)"}`);
  parts.push("");
  parts.push(
    notes
      ? `--- STUDENT'S TYPED NOTES ---\n${notes}`
      : `--- STUDENT'S TYPED NOTES ---\n(none: the student typed no notes for this lecture)`
  );
  parts.push("");
  parts.push(
    transcript
      ? `--- MACHINE TRANSCRIPT (speech-to-text, may contain recognition errors) ---\n${transcript}`
      : `--- MACHINE TRANSCRIPT ---\n(none: this device produced no speech-to-text. This is normal, not an error. Work from the notes alone.)`
  );
  parts.push("");
  parts.push(
    "Summarize the above using only what it contains. The course name and date above are metadata only: do not treat them as knowledge about what was taught."
  );
  return parts.join("\n");
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "keyPoints", "terms", "todos", "questions", "confidence"],
  properties: {
    headline: { type: "string" },
    keyPoints: { type: "array", items: { type: "string" } },
    terms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "definition"],
        properties: { term: { type: "string" }, definition: { type: "string" } },
      },
    },
    todos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" }, due: { type: "string" } },
      },
    },
    questions: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "low"] },
  },
} as const;

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const b = (raw ?? {}) as Body;
  const course = str(b.course);
  const date = str(b.date);
  const notes = str(b.notes);
  const transcript = str(b.transcript);

  // Nothing to summarize. Producing a summary from an empty lecture would be
  // pure fabrication, which is the exact thing this endpoint exists to avoid.
  if (!notes && !transcript) {
    return NextResponse.json(
      { error: "nothing to summarize: both notes and transcript are empty" },
      { status: 400 }
    );
  }

  // Refuse oversized input rather than truncating it. A silently truncated
  // lecture yields a summary that is wrong in a way nobody can see.
  const size = notes.length + transcript.length;
  if (size > MAX_CHARS) {
    return NextResponse.json(
      {
        error: "lecture too long to summarize in one request",
        chars: size,
        limit: MAX_CHARS,
        detail:
          "Not truncating, because a partial summary would look complete while missing material. Split the lecture and summarize each part.",
      },
      { status: 413 }
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Match the push route's convention: report being unconfigured honestly at
    // 200 rather than pretending an empty summary is a successful one.
    return NextResponse.json({
      configured: false,
      summary: null,
      note: "ANTHROPIC_API_KEY is not set, so no summary was generated.",
    });
  }

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: SCHEMA },
        },
        messages: [{ role: "user", content: buildPrompt(course, date, notes, transcript) }],
      }),
    });
  } catch (e) {
    return NextResponse.json(
      { error: "could not reach the summarizer", detail: String(e) },
      { status: 502 }
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `summarizer returned ${res.status}`, detail: detail.slice(0, 500) },
      { status: 502 }
    );
  }

  const data = await res.json().catch(() => null);
  if (!data) {
    return NextResponse.json({ error: "summarizer returned unreadable output" }, { status: 502 });
  }

  if (data.stop_reason === "refusal") {
    return NextResponse.json(
      { error: "the summarizer declined this lecture", detail: data.stop_details?.explanation ?? null },
      { status: 502 }
    );
  }
  if (data.stop_reason === "max_tokens") {
    // A cut-off structured response is malformed or, worse, half-complete.
    return NextResponse.json(
      { error: "summary was cut off before it finished; try a shorter section of the lecture" },
      { status: 502 }
    );
  }

  const blocks: { type: string; text?: string }[] = Array.isArray(data.content) ? data.content : [];
  const text = blocks.find((blk) => blk.type === "text")?.text ?? "";
  let summary: LectureSummary;
  try {
    summary = JSON.parse(text) as LectureSummary;
  } catch {
    return NextResponse.json(
      { error: "summarizer did not return a usable summary" },
      { status: 502 }
    );
  }

  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;

  return NextResponse.json({
    configured: true,
    course: course || null,
    date: date || null,
    hadTranscript: Boolean(transcript),
    summary,
    model: data.model ?? MODEL,
    cost: (inputTokens * 5 + outputTokens * 25) / 1_000_000,
  });
}
