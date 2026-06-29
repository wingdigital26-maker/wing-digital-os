import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { messages } = await req.json();

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: "You are Claude, the AI assistant inside Jack's Wing Digital OS. Wing Digital is a marketing automation agency for home service businesses in DFW. Be concise and helpful.",
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: err }, { status: 500 });
  }

  const data = await res.json();
  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  // claude-sonnet-4-6: $3/MTok input, $15/MTok output
  const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000;
  return NextResponse.json({ reply: data.content[0].text, cost });
}
