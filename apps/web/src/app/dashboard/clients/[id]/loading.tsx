import { Card } from "@/components/ui/Card";

/** Client-detail skeleton: back link, name header, 4-stat grid, two panels. */
export default function ClientDetailLoading() {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <div className="h-3 w-24 rounded skeleton" />
      <div className="mb-6 mt-3">
        <div className="h-8 w-56 rounded-lg skeleton" />
        <div className="mt-2 h-4 w-40 rounded skeleton" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="h-20 skeleton" />
        ))}
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card className="h-64 skeleton" />
        <Card className="h-64 skeleton" />
      </div>
      <Card className="mt-6 h-40 skeleton" />
    </main>
  );
}
