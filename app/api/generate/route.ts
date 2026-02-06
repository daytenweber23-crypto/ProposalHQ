import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    // ✅ Read Bearer token sent from the client
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ✅ Create a Supabase client that identifies the user using the token
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnon) {
      return NextResponse.json(
        { error: "Missing Supabase env vars on server" },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // 1) Must be logged in
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2) Load plan
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("plan")
      .eq("user_id", user.id)
      .maybeSingle();

    if (profileErr) {
      return NextResponse.json(
        { error: "Could not load user plan" },
        { status: 500 }
      );
    }

    const plan = profile?.plan ?? "free";

    // 3) Enforce FREE limit (3 per month)
    if (plan !== "pro") {
      const FREE_LIMIT = 3;

      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const { count, error: countErr } = await supabase
        .from("proposals")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", startOfMonth.toISOString());

      if (countErr) {
        return NextResponse.json(
          { error: "Could not check usage" },
          { status: 500 }
        );
      }

      if ((count ?? 0) >= FREE_LIMIT) {
        return NextResponse.json(
          {
            error: `Free plan limit reached (${FREE_LIMIT}/month). Upgrade to Pro for unlimited proposals.`,
            code: "FREE_LIMIT_REACHED",
            limit: FREE_LIMIT,
            used: count ?? 0,
          },
          { status: 402 }
        );
      }
    }

    // 4) Parse body
    const { clientName, notes } = await req.json();

    if (!clientName || !notes) {
      return NextResponse.json(
        { error: "Missing clientName or notes" },
        { status: 400 }
      );
    }

    // 5) OpenAI
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

    // 6) SAVE SERVER-SIDE (limit is bulletproof)
    const { data: saved, error: saveErr } = await supabase
      .from("proposals")
      .insert({
        user_id: user.id,
        client_name: String(clientName).trim(),
        notes,
        proposal,
      })
      .select("*")
      .single();

    if (saveErr) {
      console.error("Save failed:", saveErr);
      return NextResponse.json(
        { error: `Save failed: ${saveErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ proposal, saved });
  } catch (err: any) {
    console.error("API /generate ERROR:", err);

    const message =
      err?.response?.data?.error?.message || err?.message || "Unexpected error";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}


