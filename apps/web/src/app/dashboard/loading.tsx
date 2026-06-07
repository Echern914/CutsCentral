import { Card } from "@/components/ui/Card";

/** Dashboard loading skeleton - mirrors the real layout to avoid layout shift. */
export default function DashboardLoading() {
  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-8">
      <div className="mb-8 h-10 w-48 rounded-lg skeleton" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="h-32 skeleton" />
        <div className="grid grid-cols-2 gap-4 lg:col-span-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="h-24 skeleton" />
          ))}
        </div>
      </div>
      <Card className="mt-6 h-20 skeleton" />
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="h-64 skeleton" />
        <Card className="h-64 skeleton" />
      </div>
    </main>
  );
}
