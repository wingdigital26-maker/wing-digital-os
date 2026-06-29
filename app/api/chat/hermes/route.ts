import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY!}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://wingdigital.agency",
      "X-Title": "Wing Digital OS",
    },
    body: JSON.stringify({
      model: "google/gemma-3-27b-it:free",
      messages: [
        {
          role: "system",
          content: "You are Hermes, the AI assistant inside Jack's Wing Digital OS. Wing Digital is a marketing automation agency for home service businesses in DFW. Handle repetitive tasks, quick lookups, and day-to-day operations. Be fast and direct.",
        },
        ...messages,
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: err }, { status: 500 });
  }

  const data = await res.json();
  return NextResponse.json({ reply: data.choices[0].message.content, cost: 0 });
}
