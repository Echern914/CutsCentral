/** The barber's own alert preferences (mirrors NOTIFY_DEFAULTS in the API). */
export interface NotifyPrefs {
  pushEnabled: boolean;
  /** Texts about bookings (someone booked / canceled). */
  smsEnabled: boolean;
  /** Texts for the recurring reminders (next-up, day-ahead). */
  smsRemindersEnabled: boolean;
  emailEnabled: boolean;
  /** null = fall back to the shop-wide alert number. */
  notifyPhone: string | null;
  nextUpEnabled: boolean;
  nextUpLeadMin: number;
  dayAheadEnabled: boolean;
  /** Shop-local hour, 0-23. */
  dayAheadHour: number;
  newBookingEnabled: boolean;
  cancelEnabled: boolean;
}

/** A registered push device - where notifications actually land. */
export interface NotifyDevice {
  id: string;
  kind: string;
  label: string;
  lastSeenAt: string | null;
  createdAt: string;
  /** The push service has been rejecting this one. */
  failing: boolean;
}

export interface NotificationsResponse {
  prefs: NotifyPrefs;
  defaults: NotifyPrefs;
  shopNotifyPhone: string | null;
  timezone: string | null;
  devices: NotifyDevice[];
}
