import Link from "next/link";

const targets = Array.from({ length: 8 }, (_, index) => index + 1);

// More viewport-prefetched links than the four concurrent prefetch requests,
// above a spacer tall enough to scroll them all out of view. `?shared` repeats
// the links further down with a hash, so both copies share one request.
export default async function PrefetchQueueViewportPage({
  searchParams,
}: {
  searchParams: Promise<{ shared?: string }>;
}) {
  const { shared } = await searchParams;
  return (
    <main>
      <ul>
        {targets.map((target) => (
          <li key={target}>
            <Link className="queued-link" href={`/prefetch-queue-viewport/${target}`}>
              Target {target}
            </Link>
          </li>
        ))}
      </ul>
      {shared === undefined ? null : (
        <ul style={{ marginTop: "1500px" }}>
          {targets.map((target) => (
            <li key={target}>
              <Link className="shared-link" href={`/prefetch-queue-viewport/${target}#again`}>
                Again {target}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div style={{ height: "6000px" }} />
      <p id="bottom">Bottom</p>
    </main>
  );
}
