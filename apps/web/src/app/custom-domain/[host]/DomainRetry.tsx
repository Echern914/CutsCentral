/**
 * What a customer sees on a shop's own domain when we could not find out
 * whose domain it is - the lookup failed (network, timeout, rate limit, an API
 * mid-deploy), which says nothing about the domain. On the domain they tapped,
 * in plain words, with one way forward: the same link again.
 *
 * No shop is named: which shop this domain belongs to is exactly what we could
 * not find out. Fixed colours on purpose - there is no shop theme to wear.
 */
export function DomainRetry({ domain, retryHref }: { domain: string; retryHref: string }) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#111111",
        color: "#F5F2EA",
        padding: "2rem 1.5rem",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: "22rem" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
          {domain} is taking a moment to load
        </h1>
        <p style={{ margin: "0 0 1.5rem", color: "#B9B3A7" }}>
          This is usually brief. Please try again in a few seconds.
        </p>
        <a
          href={retryHref}
          style={{
            display: "inline-block",
            padding: "0.75rem 1.5rem",
            borderRadius: "0.75rem",
            background: "#C9A24A",
            color: "#111111",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Try again
        </a>
      </div>
    </main>
  );
}
