import { Card } from "@/components/ui/Card";

/** Shown when a rewards magic link is invalid or expired. */
export default function RewardsNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5">
      <Card className="p-8 text-center">
        <h1 className="font-display text-2xl">Link not found</h1>
        <p className="mt-2 text-sm text-muted">
          This rewards link isn&apos;t valid. Ask your shop to resend it.
        </p>
      </Card>
    </main>
  );
}
