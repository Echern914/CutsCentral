import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE, BARBER_MODE_ENABLED } from "@/src/config";

/**
 * First screen: "Customer or Barber?". The choice is remembered, so a returning
 * user is sent straight to their mode on next launch (the "send them through
 * right away" behavior) - they only see this picker the first time, or after
 * switching modes. A deep link (chairback://r/<token> or the universal link)
 * bypasses this entirely and lands in customer mode.
 *
 * v1: barber mode is disabled (BARBER_MODE_ENABLED=false), so there is only one
 * destination - we skip the picker entirely and go straight to the customer
 * rewards experience.
 */
export default function ModePicker() {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      // v1: only customer mode exists - route straight in, no picker.
      if (!BARBER_MODE_ENABLED) {
        router.replace("/customer");
        return;
      }
      const saved = await AsyncStorage.getItem(STORAGE.mode);
      if (saved === "customer") router.replace("/customer");
      else if (saved === "barber") router.replace("/barber");
      else setChecking(false);
    })();
  }, []);

  async function choose(mode: "customer" | "barber") {
    await AsyncStorage.setItem(STORAGE.mode, mode);
    router.replace(mode === "customer" ? "/customer" : "/barber");
  }

  if (checking) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.brand}>ChairBack</Text>
        <Text style={styles.tagline}>Stay on top of your rewards & bookings.</Text>
      </View>
      <View style={styles.choices}>
        <Pressable style={styles.card} onPress={() => choose("customer")}>
          <Text style={styles.cardTitle}>I&apos;m a customer</Text>
          <Text style={styles.cardSub}>See your punches & rewards, get reminders.</Text>
        </Pressable>
        <Pressable style={styles.card} onPress={() => choose("barber")}>
          <Text style={styles.cardTitle}>I&apos;m a barber</Text>
          <Text style={styles.cardSub}>Your shop dashboard & booking alerts.</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0B", padding: 24, justifyContent: "center" },
  center: { alignItems: "center", justifyContent: "center" },
  hero: { marginBottom: 40, alignItems: "center" },
  brand: { color: "#fff", fontSize: 34, fontWeight: "700", letterSpacing: -0.5 },
  tagline: { color: "#8a8a8f", fontSize: 15, marginTop: 8, textAlign: "center" },
  choices: { gap: 14 },
  card: { backgroundColor: "#151517", borderRadius: 16, borderWidth: 1, borderColor: "#26262b", padding: 20 },
  cardTitle: { color: "#fff", fontSize: 18, fontWeight: "600" },
  cardSub: { color: "#8a8a8f", fontSize: 13, marginTop: 4 },
});
