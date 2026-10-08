export function Progress({ labels, current }: { labels: string[]; current: number }) {
  return (
    <nav aria-label="Booking progress" className="mb-6">
      <p className="text-sm font-medium text-neutral-700">
        Step {current + 1} of {labels.length}: <span className="text-neutral-950">{labels[current]}</span>
      </p>
      <ol className="mt-2 flex gap-1" aria-hidden="true">
        {labels.map((label, i) => (
          <li key={label} className={`h-1.5 flex-1 rounded-full ${i <= current ? "bg-neutral-900" : "bg-neutral-300"}`} />
        ))}
      </ol>
    </nav>
  );
}
