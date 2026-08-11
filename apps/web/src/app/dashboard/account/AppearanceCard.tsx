"use client";

import { Card, CardHeader } from "@/components/ui/Card";
import { ThemePicker } from "@/components/ThemePicker";
import { useToast } from "@/components/ui/Toast";
import { saveThemeAction } from "../actions";
import type { Theme } from "@/lib/theme";

/**
 * Account → Appearance: the standing home of the theme switch (onboarding
 * offers the same choice once, at signup). Applies instantly; a failed save
 * only means the choice won't follow the account to another device yet, and
 * the toast says exactly that rather than reverting the screen under the tap.
 */
export function AppearanceCard({ initialTheme }: { initialTheme: Theme }) {
  const { toast } = useToast();
  return (
    <Card className="p-5">
      <CardHeader
        title="Appearance"
        subtitle="Your dashboard, your eyes. Clients always see your shop's own branding."
      />
      <div className="mt-4">
        <ThemePicker
          value={initialTheme}
          onPick={async (t) => {
            const r = await saveThemeAction(t);
            if (!r.ok) {
              toast(
                "Couldn't save the choice — it applies here but won't follow your account yet",
                "error",
              );
            }
          }}
        />
      </div>
    </Card>
  );
}
