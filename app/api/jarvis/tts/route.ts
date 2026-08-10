import { NextRequest, NextResponse } from "next/server";

// ───────────────────────────────────────────────────────────────────────────
// Jarvis TTS — streams ElevenLabs audio for the Jarvis voice replies.
// Auth is inherited from middleware.ts like every other route.
// The client falls back to browser speechSynthesis if this errors.
// ───────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

// Voice: "George" (ElevenLabs premade) — warm, calm, confident British male.
// Picked for the assistant vibe: composed and capable, not theatrical.
const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const MODEL_ID = "eleven_turbo_v2_5"; // low latency, good quality
const MAX_CHARS = 800;

// Strip markdown noise so the voice does not read asterisks and code fences.
function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

export async function POST(req: NextRequest) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "TTS not configured" }, { status: 503 });
  }

  let text = "";
  try {
    const body = await req.json();
    if (typeof body?.text === "string") text = body.text;
  } catch {
    /* fall through to empty-text check */
  }
  const clean = cleanForSpeech(text);
  if (!clean) {
    return NextResponse.json({ error: "No text" }, { status: 400 });
  }

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: clean,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15 },
      }),
    }
  );

  if (!upstream.ok || !upstream.body) {
    // Do not leak upstream error bodies (may echo request details).
    return NextResponse.json(
      { error: "TTS upstream failed" },
      { status: upstream.status === 401 ? 503 : 502 }
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
    },
  });
}
