import Link from "next/link";

// More viewport-prefetched links than the four concurrent prefetch requests,
// above a spacer tall enough to scroll them all out of view.
export default function PrefetchQueueViewportPage() {
  return (
    <main>
      <ul>
        {Array.from({ length: 8 }, (_, index) => (
          <li key={index}>
            <Link className="queued-link" href={`/prefetch-queue-viewport/${index + 1}`}>
              Target {index + 1}
            </Link>
          </li>
        ))}
      </ul>
      <div style={{ height: "6000px" }} />
      <p id="bottom">Bottom</p>
    </main>
  );
}
