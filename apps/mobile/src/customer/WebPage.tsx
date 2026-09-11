import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { AppWebView } from "@/src/AppWebView";
import { WEB_ORIGIN } from "@/src/config";
import { errorCopy } from "./api";
import { color, space } from "./theme";
import { ErrorState, Placeholder, Tap, Txt } from "./ui";

/**
 * A shop's own web page (storefront, booking, manage) inside My ChairBack.
 *
 * It is the EXISTING page, byte for byte - the app never rebuilds a
 * storefront. What the app adds is the frame: a native bar with the shop's
 * name and a "Done" that always returns to My ChairBack, whatever the page
 * inside has navigated to. The URL is fetched on open (it carries this
 * customer's own link) and never cached.
 *
 * Only ChairBack's own origin is ever loaded as the first page: a URL that
 * arrived any other way is refused before the WebView sees it.
 */
export function WebPage({
  title,
  load,
  onClose,
  onMessage,
}: {
  title: string;
  /** Resolve the page's URL (from the API, or a known link). */
  load: () => Promise<string>;
  onClose?: () => void;
  /** Bridge messages the page posts (e.g. "cb:deleted"). */
  onMessage?: (data: string) => void;
}) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    load()
      .then((u) => {
        if (!alive) return;
        if (!u.startsWith(`${WEB_ORIGIN}/`)) throw new Error("off_origin");
        setUrl(u);
      })
      .catch((err) => alive && setError(err));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  function done() {
    onClose?.();
    if (router.canGoBack()) router.back();
    else router.replace("/customer");
  }

  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          title,
          headerLeft: () => (
            <Tap onPress={done} accessibilityLabel="Done" accessibilityHint="Returns to My ChairBack" style={styles.done}>
              <Txt variant="headline" tone="gold">
                Done
              </Txt>
            </Tap>
          ),
        }}
      />
      {url ? (
        <AppWebView
          source={{ uri: url }}
          style={styles.root}
          awaitsReady
          onMessage={(e) => onMessage?.(e.nativeEvent.data)}
        />
      ) : error ? (
        <View style={styles.pad}>
          <ErrorState {...errorCopy(error)} onRetry={() => setAttempt((n) => n + 1)} />
        </View>
      ) : (
        <View style={styles.pad}>
          <Placeholder height={200} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  pad: { padding: space.s3 },
  done: { minHeight: 44, minWidth: 44, justifyContent: "center" },
});
