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
  /** Extra warning on a job the barber drives to. 0 = off (most shops). */
  travelBufferMin: number;
  dayAheadEnabled: boolean;
  /** Shop-local hour, 0-23. */
  dayAheadHour: number;
  newBookingEnabled: boolean;
  cancelEnabled: boolean;
  /** The Lock Screen widget shows client first names. */
  lockScreenNames: boolean;
  /**
   * The owner's switch: also tell me about bookings on chairs someone else
   * works. Only the owner can change it (the API refuses anyone else).
   */
  otherChairsEnabled: boolean;
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
  /** True for an owner with at least one chair worked by another login. */
  otherChairsApplies?: boolean;
  timezone: string | null;
  devices: NotifyDevice[];
}
