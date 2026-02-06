"use client";

import { useEffect, useMemo, useState } from "react";
import jsPDF from "jspdf";
import { supabase } from "@/lib/supabase/client";

type ProposalRow = {
  id: string;
  user_id: string;
  client_name: string;
  notes: string;
  proposal: string;
  created_at: string;
};

type ProfileRow = {
  user_id: string;
  email: string | null;
  plan: "free" | "pro";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  updated_at: string;
};

export default function Page() {
  const [clientName, setClientName] = useState("");
  const [notes, setNotes] = useState("");
  const [proposal, setProposal] = useState("");
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Auth UI state
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Plan state
  const [plan, setPlan] = useState<"free" | "pro">("free");
  const [planLoading, setPlanLoading] = useState(false);

  // History state
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rows, setRows] = useState<ProposalRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function init() {
      const { data } = await supabase.auth.getUser();
      if (!mounted) return;

      setUserEmail(data.user?.email ?? null);
      setUserId(data.user?.id ?? null);
      setAuthLoading(false);
    }

    init();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user?.email ?? null);
      setUserId(session?.user?.id ?? null);
      setAuthLoading(false);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // ✅ Ensure profile exists + load plan after login
  useEffect(() => {
    if (!userId) return;
    void ensureProfileAndLoadPlan(userId, userEmail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // ✅ If we returned from Stripe success page (session_id in URL), refresh plan again
  useEffect(() => {
    if (!userId) return;

    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (!sessionId) return;

    const t = setTimeout(() => {
      void ensureProfileAndLoadPlan(userId, userEmail);
    }, 800);

    const clean = setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("session_id");
      window.history.replaceState({}, "", url.toString());
    }, 1200);

    return () => {
      clearTimeout(t);
      clearTimeout(clean);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // ✅ Load history after login
  useEffect(() => {
    if (!userId) return;
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const canGenerate = useMemo(() => {
    return clientName.trim().length > 0 && notes.trim().length > 20;
  }, [clientName, notes]);

  async function ensureProfileAndLoadPlan(uid: string, email: string | null) {
    setError(null);
    setPlanLoading(true);

    try {
      const { data: existing, error: fetchErr } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", uid)
        .maybeSingle();

      if (fetchErr) throw fetchErr;

      if (!existing) {
        const { data: inserted, error: insertErr } = await supabase
          .from("profiles")
          .insert({
            user_id: uid,
            email: email ?? null,
            plan: "free",
          })
          .select("*")
          .single();

        if (insertErr) throw insertErr;

        const created = inserted as ProfileRow;
        setPlan(created.plan ?? "free");
        return;
      }

      const profile = existing as ProfileRow;
      setPlan(profile.plan ?? "free");
    } catch (e: any) {
      console.error(e);
      setError(e?.message ?? "Failed to load plan");
      setPlan("free");
    } finally {
      setPlanLoading(false);
    }
  }

  async function loadHistory() {
    if (!userId) return;

    setError(null);
    setHistoryLoading(true);

    const { data, error } = await supabase
      .from("proposals")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    setHistoryLoading(false);

    if (error) {
      console.error(error);
      setError(error.message);
      return;
    }

    setRows((data as ProposalRow[]) ?? []);
  }

  async function deleteProposal(id: string) {
    setError(null);

    if (!userId) {
      setError("Missing user. Please refresh.");
      return;
    }

    const { error } = await supabase
      .from("proposals")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      console.error(error);
      setError(error.message);
      return;
    }

    setRows((prev) => prev.filter((r) => r.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setClientName("");
      setNotes("");
      setProposal("");
    }
  }

  function loadIntoEditor(r: ProposalRow) {
    setActiveId(r.id);
    setClientName(r.client_name);
    setNotes(r.notes);
    setProposal(r.proposal);
    setError(null);
  }

  function newProposal() {
    setActiveId(null);
    setClientName("");
    setNotes("");
    setProposal("");
    setError(null);
  }

  // ✅ FIX: send Supabase access token to server so /api/generate can auth reliably on mobile
  async function generateProposal() {
    setError(null);
    setLoading(true);
    setProposal("");

    try {
      const {
        data: { session },
        error: sessionErr,
      } = await supabase.auth.getSession();

      if (sessionErr) throw sessionErr;

      const token = session?.access_token;
      if (!token) {
        setError("Session missing. Please sign out and sign back in.");
        return;
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`, // ✅ IMPORTANT
        },
        body: JSON.stringify({ clientName, notes }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 402 && data?.code === "FREE_LIMIT_REACHED") {
        setError(data?.error || "Free plan limit reached. Upgrade to Pro.");
        return;
      }

      if (res.status === 401) {
        setError("Unauthorized. Please sign out and sign back in.");
        return;
      }

      if (!res.ok) {
        throw new Error(data?.error || `Request failed (${res.status})`);
      }

      const generated = data?.proposal || "No proposal returned.";
      setProposal(generated);

      const saved = data?.saved;
      if (saved?.id) {
        setRows((prev) => [saved as ProposalRow, ...prev]);
        setActiveId(saved.id);
      } else {
        void loadHistory();
      }
    } catch (e: any) {
      setError(e?.message ?? "Error generating proposal");
    } finally {
      setLoading(false);
    }
  }

  function exportPdf() {
    const doc = new jsPDF({ unit: "pt", format: "letter" });

    const marginX = 40;
    const marginY = 50;
    const pageHeight = doc.internal.pageSize.height;
    let y = marginY;

    doc.setFontSize(18);
    doc.text(`Marketing Proposal – ${clientName || "Client"}`, marginX, y);
    y += 30;

    doc.setFontSize(11);
    const text = proposal || "No proposal yet.";
    const lines = doc.splitTextToSize(text, 520);

    lines.forEach((line: string) => {
      if (y > pageHeight - marginY) {
        doc.addPage();
        y = marginY;
      }
      doc.text(line, marginX, y);
      y += 14;
    });

    doc.save(`${(clientName || "client").replaceAll(" ", "_")}_proposal.pdf`);
  }

  async function signInWithGoogle() {
    setError(null);

    const origin = window.location.origin;
    const redirectTo = `${origin}/auth/callback`;

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: {
          prompt: "select_account",
          access_type: "offline",
          include_granted_scopes: "true",
        },
      },
    });

    if (error) {
      console.error(error);
      setError(error.message);
      return;
    }

    if (data?.url) window.location.assign(data.url);
    else setError("No OAuth URL returned. Google provider may not be enabled.");
  }

  async function signOut() {
    setError(null);
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error(error);
      setError(error.message);
    }
  }

  async function upgradeToPro() {
    setError(null);

    try {
      const { data } = await supabase.auth.getUser();
      const email = data.user?.email;

      if (!email) {
        setError("No email found. Please sign out and sign in again.");
        return;
      }

      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, userId }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Checkout failed (${res.status})`);
      }

      if (!json?.url) {
        throw new Error("No checkout URL returned.");
      }

      window.location.assign(json.url);
    } catch (e: any) {
      setError(e?.message ?? "Upgrade failed");
    }
  }

  async function openBillingPortal() {
    setError(null);

    try {
      if (!userId) {
        setError("Missing user. Please refresh.");
        return;
      }

      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || `Portal failed (${res.status})`);
      }

      if (!json?.url) {
        throw new Error("No portal URL returned.");
      }

      window.location.assign(json.url);
    } catch (e: any) {
      setError(e?.message ?? "Could not open billing portal");
    }
  }

  function Logo() {
    return (
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-xl bg-black text-white font-semibold">
          HQ
        </div>
        <div className="leading-tight">
          <div className="text-lg font-semibold">ProposalHQ</div>
          <div className="text-xs text-neutral-500">
            Client-ready proposals in minutes
          </div>
        </div>
      </div>
    );
  }

  function PlanBadge() {
    const isPro = plan === "pro";
    return (
      <span
        className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${
          isPro
            ? "bg-green-50 text-green-700 ring-green-200"
            : "bg-neutral-100 text-neutral-700 ring-neutral-200"
        }`}
        title={isPro ? "Pro plan active" : "Free plan"}
      >
        {planLoading ? "Checking plan…" : isPro ? "Pro" : "Free"}
      </span>
    );
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-neutral-50">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <Logo />
          <div className="mt-8 text-sm text-neutral-600">Loading…</div>
        </div>
      </div>
    );
  }

  if (!userEmail) {
    return (
      <div className="min-h-screen bg-neutral-50">
        <div className="mx-auto max-w-5xl px-4 py-10">
          <div className="flex items-center justify-between">
            <Logo />
          </div>

          <div className="mt-10 grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200">
              <h1 className="text-2xl font-semibold tracking-tight">
                ProposalHQ
              </h1>
              <p className="mt-2 text-neutral-600">
                Generate clean, client-ready marketing proposals from discovery
                notes — fast.
              </p>

              <ul className="mt-5 space-y-2 text-sm text-neutral-600">
                <li>
                  • Structured proposal sections (goals, scope, plan, pricing)
                </li>
                <li>• One-click PDF export with clean page breaks</li>
                <li>• Proposal history saved per user</li>
              </ul>

              <button
                onClick={signInWithGoogle}
                className="mt-6 inline-flex items-center justify-center rounded-xl bg-black px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
              >
                Sign in with Google
              </button>

              {error && (
                <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <div className="mt-6 flex gap-3 text-xs text-neutral-500">
                <a href="/terms" className="hover:underline">
                  Terms
                </a>
                <a href="/privacy" className="hover:underline">
                  Privacy
                </a>
              </div>
            </div>

            <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200">
              <div className="text-sm font-medium text-neutral-900">
                What agencies use this for
              </div>
              <p className="mt-2 text-sm text-neutral-600">
                ProposalHQ turns messy notes into polished proposals and saves
                them so your team can reuse and iterate fast.
              </p>

              <div className="mt-6 rounded-2xl bg-neutral-50 p-4 ring-1 ring-neutral-200">
                <div className="text-xs font-semibold text-neutral-500">TIP</div>
                <div className="mt-1 text-sm text-neutral-700">
                  Include budget + timeline in notes for stronger output.
                </div>
              </div>

              <div className="mt-6 text-xs text-neutral-500">
                Don’t paste sensitive personal client data.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isPro = plan === "pro";

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex items-center justify-between">
          <Logo />
          <div className="flex items-center gap-3">
            <PlanBadge />

            <div className="hidden sm:block text-sm text-neutral-600">
              Signed in as <span className="font-medium">{userEmail}</span>
            </div>

            {isPro && (
              <button
                onClick={openBillingPortal}
                className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm font-medium hover:bg-neutral-100"
              >
                Manage billing
              </button>
            )}

            {!isPro && (
              <button
                onClick={upgradeToPro}
                className="rounded-xl bg-black px-3 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                Upgrade to Pro
              </button>
            )}

            <button
              onClick={signOut}
              className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm font-medium hover:bg-neutral-100"
            >
              Sign out
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-12">
          <aside className="lg:col-span-4">
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-neutral-200">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-neutral-900">
                    Proposal history
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
                    Saved to your account
                  </div>
                </div>
                <button
                  onClick={newProposal}
                  className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs font-medium hover:bg-neutral-100"
                >
                  New
                </button>
              </div>

              <div className="mt-4">
                <button
                  onClick={loadHistory}
                  className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm font-medium hover:bg-neutral-100"
                >
                  {historyLoading ? "Refreshing…" : "Refresh list"}
                </button>
              </div>

              <div className="mt-4 space-y-2">
                {rows.length === 0 ? (
                  <div className="rounded-xl bg-neutral-50 p-4 text-sm text-neutral-600 ring-1 ring-neutral-200">
                    No saved proposals yet. Generate one to create your first
                    saved record.
                  </div>
                ) : (
                  rows.map((r) => (
                    <div
                      key={r.id}
                      className={`rounded-xl border p-3 ${
                        activeId === r.id
                          ? "border-neutral-900 bg-neutral-50"
                          : "border-neutral-200 bg-white hover:bg-neutral-50"
                      }`}
                    >
                      <button
                        onClick={() => loadIntoEditor(r)}
                        className="w-full text-left"
                      >
                        <div className="text-sm font-semibold text-neutral-900">
                          {r.client_name}
                        </div>
                        <div className="mt-1 text-xs text-neutral-500">
                          {new Date(r.created_at).toLocaleString()}
                        </div>
                      </button>

                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => loadIntoEditor(r)}
                          className="rounded-lg bg-black px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
                        >
                          Open
                        </button>
                        <button
                          onClick={() => deleteProposal(r.id)}
                          className="rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-100"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>

          <main className="lg:col-span-8">
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">New proposal</h2>
                    <p className="mt-1 text-sm text-neutral-600">
                      Add the client name + discovery notes, then generate.
                    </p>
                  </div>
                  <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-600">
                    {activeId ? "Saved" : "Draft"}
                  </span>
                </div>

                <div className="mt-5">
                  <label className="text-sm font-medium text-neutral-900">
                    Client name
                  </label>
                  <input
                    className="mt-2 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-900"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="Acme Marketing"
                  />
                </div>

                <div className="mt-4">
                  <label className="text-sm font-medium text-neutral-900">
                    Discovery notes
                  </label>
                  <textarea
                    className="mt-2 h-44 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-900"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={
                      "• Current channels:\n• What’s not working:\n• Audience:\n• Budget:\n• Timeline:\n• Constraints:\n"
                    }
                  />
                  <div className="mt-2 text-xs text-neutral-500">
                    Minimum 20 characters. Bullet points work best.
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    onClick={generateProposal}
                    disabled={!canGenerate || loading}
                    className={`rounded-xl px-4 py-2.5 text-sm font-medium text-white ${
                      !canGenerate || loading
                        ? "bg-neutral-400 cursor-not-allowed"
                        : "bg-black hover:opacity-90"
                    }`}
                  >
                    {loading ? "Generating…" : "Generate proposal"}
                  </button>

                  <button
                    onClick={exportPdf}
                    disabled={!proposal}
                    className={`rounded-xl border px-4 py-2.5 text-sm font-medium ${
                      proposal
                        ? "border-neutral-300 bg-white hover:bg-neutral-100"
                        : "border-neutral-200 bg-neutral-100 text-neutral-400 cursor-not-allowed"
                    }`}
                  >
                    Export PDF
                  </button>
                </div>

                {error && (
                  <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {error}
                  </div>
                )}
              </div>

              <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-neutral-200">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Proposal output</h2>
                    <p className="mt-1 text-sm text-neutral-600">
                      Review, edit, then export to PDF.
                    </p>
                  </div>
                  {proposal && (
                    <span className="rounded-full bg-green-50 px-3 py-1 text-xs text-green-700 ring-1 ring-green-200">
                      Ready
                    </span>
                  )}
                </div>

                <div className="mt-5">
                  {!proposal ? (
                    <div className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50 p-6 text-sm text-neutral-600">
                      Generate a proposal to see it here.
                    </div>
                  ) : (
                    <div className="max-h-[560px] overflow-auto rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
                      <pre className="whitespace-pre-wrap text-sm leading-6 text-neutral-900">
                        {proposal}
                      </pre>
                    </div>
                  )}
                </div>

                {proposal && (
                  <div className="mt-4 text-xs text-neutral-500">
                    Tip: Add budget + timeline + competitors in notes for
                    stronger output.
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
              <span>
                ProposalHQ • Saved per user • Do not paste confidential personal
                data.
              </span>
              <span className="hidden sm:inline">•</span>
              <a href="/terms" className="hover:underline">
                Terms
              </a>
              <a href="/privacy" className="hover:underline">
                Privacy
              </a>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}










  







