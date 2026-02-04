export default function SuccessPage() {
  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: 20 }}>
      <h1>✅ You’re all set!</h1>

      <p style={{ marginTop: 12 }}>
        Your subscription checkout completed successfully.
      </p>

      <p style={{ marginTop: 8, color: "#555" }}>
        You now have access to all ProposalHQ Pro features.
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

