import { Icon, Label, NativeTabs } from "expo-router/unstable-native-tabs";
import { color } from "@/src/customer/theme";

/**
 * The persistent tab bar - the platform's own (UITabBar via
 * react-native-screens), so it behaves, reads to VoiceOver, scales with text
 * and takes on the system's material exactly like a first-party app's.
 * Home first; Book shows the customer's own shops and never picks one for them.
 */
export default function CustomerTabs() {
  return (
    <NativeTabs
      tintColor={color.goldText}
      iconColor={{ default: color.textSecondary, selected: color.goldText }}
      labelStyle={{ default: { color: color.textSecondary }, selected: { color: color.goldText } }}
      minimizeBehavior="never"
    >
      <NativeTabs.Trigger name="index">
        <Label>Home</Label>
        <Icon sf={{ default: "house", selected: "house.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="book">
        <Label>Book</Label>
        <Icon sf={{ default: "plus.circle", selected: "plus.circle.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="appointments">
        <Label>Appointments</Label>
        <Icon sf={{ default: "calendar", selected: "calendar" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="rewards">
        <Label>Rewards</Label>
        <Icon sf={{ default: "gift", selected: "gift.fill" }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <Label>Profile</Label>
        <Icon sf={{ default: "person.crop.circle", selected: "person.crop.circle.fill" }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
