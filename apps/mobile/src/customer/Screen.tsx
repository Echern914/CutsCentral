import type { ReactNode } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { color, space } from "./theme";
import { Txt } from "./ui";

/**
 * The scroll every tab is built on.
 *
 * `contentInsetAdjustmentBehavior="automatic"` lets iOS keep content clear of
 * the native tab bar (and the home indicator) the way system apps do; the top
 * inset is applied by hand because tab screens here draw their own header
 * rather than a navigation bar. Pull to refresh is the native control.
 */
export function Screen({
  title,
  header,
  children,
  refreshing,
  onRefresh,
  underNavBar = false,
}: {
  /** A large title, iOS style - the tab's own name. */
  title?: string;
  /** Or a custom header (the home's wordmark row). */
  header?: ReactNode;
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** A pushed screen with a native navigation bar: iOS insets for it already. */
  underNavBar?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.root}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.content, { paddingTop: underNavBar ? space.s2 : insets.top + space.s1 }]}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={color.textSecondary} />
        ) : undefined
      }
    >
      {header}
      {title ? (
        <Txt variant="largeTitle" accessibilityRole="header" style={styles.title}>
          {title}
        </Txt>
      ) : null}
      <View>{children}</View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { paddingHorizontal: space.s2 + 4, paddingBottom: space.s6 },
  title: { marginTop: space.s1, marginBottom: space.s2 },
});
