export default function CancelPage() {
  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: 20 }}>
      <h1>Checkout canceled</h1>

      <p style={{ marginTop: 12 }}>
        No worries — your card was not charged.
      </p>

      <p style={{ marginTop: 8, color: "#555" }}>
        You can upgrade to ProposalHQ Pro anytime.
      </p>

      <a
        href="/"
        style={{
          display: "inline-block",
          marginTop: 20,
          fontWeight: 500,
          textDecoration: "none",
        }}
      >
        ← Back to ProposalHQ
      </a>
    </div>
  );
}

