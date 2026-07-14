"use client";

import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { pressable } from "@/components/motion/variants";
import { deleteMyDataAction } from "./actions";
import { surfaceStyle, type RewardsTheme } from "./theme";

/**
 * Client self-serve data deletion (App Store guideline 5.1.1(v): a person who
 * can be identified in the app must be able to delete their data from the app).
 * A quiet link at the bottom of the rewards page that expands into a confirm,
 * then anonymizes the client's data server-side and voids this magic link.
 *
 * On success it tells the native iOS shell (react-native-webview) to forget the
 * now-dead token via a "cb:deleted" postMessage - harmless in a normal browser,
 * where ReactNativeWebView is undefined - and shows a terminal "deleted" state
 * (re-fetching would 404, since the link is gone).
 *
 * Theme-driven like the other rewards cards, so it matches the shop's identity.
 */
export function DeleteMyData({
  magicToken,
  shopName,
  theme,
}: {
  magicToken: string;
  shopName: string;
  theme: RewardsTheme;
}) {
  const [stage, setStage] = useState<"idle" | "confirm" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function del() {
    setError(null);
    startTransition(async () => {
      const res = await deleteMyDataAction(magicToken);
      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      const w = window as unknown as {
        ReactNativeWebView?: { postMessage: (m: string) => void };
      };
      w.ReactNativeWebView?.postMessage("cb:deleted");
      setStage("done");
    });
  }

  if (stage === "done") {
    return (
      <p className="px-1 text-center text-xs" style={{ color: theme.muted }}>
        Your data has been deleted. You can close this page.
      </p>
    );
  }

  if (stage === "confirm") {
    return (
      <div className="p-5" style={surfaceStyle(theme)}>
        <p className="text-sm font-semibold">Delete your data?</p>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: theme.muted }}>
          This permanently removes your rewards profile and visit history at{" "}
          {shopName}, stops all texts, and disables this link. It can&apos;t be
          undone.
        </p>
        {error && (
          <p className="mt-2 text-xs" style={{ color: "#ef4444" }}>
            {error}
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          <motion.button
            {...pressable}
            type="button"
            onClick={del}
            disabled={pending}
            className="flex-1 px-4 py-2.5 text-sm font-semibold transition-all duration-150 ease-out disabled:pointer-events-none disabled:opacity-50"
            style={{
              backgroundColor: "#ef4444",
              color: "#ffffff",
              borderRadius: theme.buttonRadius,
            }}
          >
            {pending ? "Deleting…" : "Delete my data"}
          </motion.button>
          <button
            type="button"
            onClick={() => setStage("idle")}
            disabled={pending}
            className="px-4 py-2.5 text-sm transition-colors duration-150 ease-out disabled:opacity-50"
            style={{ color: theme.muted }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <p className="px-1 text-center text-xs" style={{ color: theme.muted }}>
      <button
        type="button"
        onClick={() => setStage("confirm")}
        className="underline underline-offset-2 transition-colors duration-150 ease-out"
      >
        Delete my data
      </button>
    </p>
  );
}
