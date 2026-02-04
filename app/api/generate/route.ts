import { NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";

export async function POST(req: Request) {
  console.log("ENV KEY LOADED?", Boolean(process.env.OPENAI_API_KEY));

  try {
    const { clientName, notes } = await req.json();

    if (!clientName || !notes) {
      return NextResponse.json(
        { error: "Missing clientName or notes" },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is missing on the server" },
        { status: 500 }
      );
    }

    const openai = new OpenAI({ apiKey });

    const prompt = `Write a client-ready marketing proposal for ${clientName}.
Discovery notes:
${notes}

Include sections:
1) Executive Summary
2) Goals & Success Metrics
3) Current Situation
4) Strategy Overview
5) Scope of Work (bullets)
6) 30/60/90 Day Plan
7) Pricing Options (3 tiers; middle is Recommended)
8) Assumptions & What We Need From You
9) Next Steps

Rules: be specific, no fake results.`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You write confident, clear agency proposals." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    });

    const proposal = resp.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({ proposal });
  } catch (err: any) {
    console.error("API /generate ERROR:", err);

    // Try to return something human-readable
    const message =
      err?.response?.data?.error?.message ||
      err?.message ||
      JSON.stringify(err);

    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
