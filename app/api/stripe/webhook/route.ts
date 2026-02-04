import Stripe from "stripe";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs"; // ✅ webhooks need Node runtime

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  // ✅ Use the same API version your Stripe CLI is using
  apiVersion: "2026-01-28.clover",
});

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  // IMPORTANT: this must be SERVICE ROLE key (server-only), NOT anon key
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function toStripeSubscription(obj: unknown): Stripe.Subscription {
  // Stripe SDK may return Stripe.Response<Stripe.Subscription> (wrapper) in some typings
  if (obj && typeof obj === "object") {
    // If it's a wrapper with `.data`
    if ("data" in obj && (obj as any).data) return (obj as any).data as Stripe.Subscription;

    // If it's already a Subscription
    return obj as Stripe.Subscription;
  }
  throw new Error("Could not parse Stripe subscription object");
}

function unixToIso(unixSeconds?: number | null): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

async function upsertProfile(params: {
  user_id: string;
  email?: string | null;
  plan: "free" | "pro";
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  current_period_end?: string | null; // ISO string for timestamptz
}) {
  const { error } = await supabaseAdmin.from("profiles").upsert(
    {
      user_id: params.user_id,
      email: params.email ?? null,
      plan: params.plan,
      stripe_customer_id: params.stripe_customer_id ?? null,
      stripe_subscription_id: params.stripe_subscription_id ?? null,
      current_period_end: params.current_period_end ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
}

export async function POST(req: Request) {
  try {
    const sig = req.headers.get("stripe-signature");
    if (!sig) {
      return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
    }

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return NextResponse.json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, { status: 500 });
    }

    // ✅ raw body required
    const rawBody = await req.text();

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
      console.error("Stripe signature verification failed:", err?.message ?? err);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    // ---------------------------
    // 1) Checkout completed
    // ---------------------------
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      // ✅ If Stripe CLI triggers a non-subscription checkout, don't 400 forever
      if (session.mode !== "subscription") {
        return NextResponse.json({ ok: true, note: "Ignored non-subscription checkout" });
      }

      const userId = session.metadata?.user_id;
      if (!userId) {
        // ⚠️ returning 200 avoids Stripe retries if you ever get a session without metadata
        return NextResponse.json({ ok: true, note: "Missing session.metadata.user_id" });
      }

      const customerId =
        typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;

      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null;

      let currentPeriodEndIso: string | null = null;

      if (subscriptionId) {
        const subRaw = await stripe.subscriptions.retrieve(subscriptionId);
        const sub = toStripeSubscription(subRaw);

        // ✅ Avoid TS red: Stripe typings sometimes vary; safely read it
        const cpe = (sub as any).current_period_end as number | undefined;
        currentPeriodEndIso = unixToIso(cpe ?? null);
      }

      await upsertProfile({
        user_id: userId,
        email: session.customer_details?.email ?? session.customer_email ?? null,
        plan: "pro",
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        current_period_end: currentPeriodEndIso,
      });

      return NextResponse.json({ ok: true });
    }

    // ---------------------------
    // 2) Subscription updated
    // ---------------------------
    if (event.type === "customer.subscription.updated") {
      const subEvent = event.data.object as Stripe.Subscription;

      const customerId =
        typeof subEvent.customer === "string" ? subEvent.customer : (subEvent.customer as any).id;

      // Find profile by customer id
      const { data: profile, error: profileErr } = await supabaseAdmin
        .from("profiles")
        .select("user_id,email")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();

      if (profileErr) throw new Error(profileErr.message);
      if (!profile) return NextResponse.json({ ok: true, note: "No profile for customer" });

      const status = (subEvent as any).status as string | undefined;
      const plan: "free" | "pro" = status === "active" ? "pro" : "free";

      const cpe = (subEvent as any).current_period_end as number | undefined;
      const currentPeriodEndIso = unixToIso(cpe ?? null);

      await upsertProfile({
        user_id: profile.user_id,
        email: profile.email ?? null,
        plan,
        stripe_customer_id: customerId,
        stripe_subscription_id: (subEvent as any).id ?? null,
        current_period_end: currentPeriodEndIso,
      });

      return NextResponse.json({ ok: true });
    }

    // ---------------------------
    // 3) Subscription deleted
    // ---------------------------
    if (event.type === "customer.subscription.deleted") {
      const subEvent = event.data.object as Stripe.Subscription;

      const customerId =
        typeof subEvent.customer === "string" ? subEvent.customer : (subEvent.customer as any).id;

      const { data: profile, error: profileErr } = await supabaseAdmin
        .from("profiles")
        .select("user_id,email")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();

      if (profileErr) throw new Error(profileErr.message);
      if (!profile) return NextResponse.json({ ok: true, note: "No profile for customer" });

      await upsertProfile({
        user_id: profile.user_id,
        email: profile.email ?? null,
        plan: "free",
        stripe_customer_id: customerId,
        stripe_subscription_id: null,
        current_period_end: null,
      });

      return NextResponse.json({ ok: true });
    }

    // Ignore other events
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Stripe webhook error:", err);
    return NextResponse.json({ error: err?.message ?? "Webhook error" }, { status: 400 });
  }
}
