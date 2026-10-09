import SwiftUI
import WidgetKit

// THE LOCK SCREEN WIDGET: "Next: Sam · 2:30 PM · Fade".
//
// 🔴 UNPROVEN UNTIL BUILT ON THE MAC. Nothing in this folder can be compiled
// on the Windows machine it was written on; it was written against Apple's
// published WidgetKit API and must be built, installed and looked at on a real
// iPhone before anyone relies on it (docs in the PR).
//
// HOW IT GETS ITS DATA. The app writes two things into the shared App Group
// (src/nextUpWidget.ts): a snapshot of who's next (GET /api/next-up) and a
// widget token that can read only that route. The widget shows the snapshot,
// flipping to the next client at each start time on its own, and refreshes it
// with the token about every half hour - so a booking made after the app was
// last opened still appears. A 401 means the barber signed out (or was
// removed): the widget forgets everything and says so, rather than leaving a
// shop's clients on a lock screen.

let appGroup = "group.com.getchairback.rewards"

enum Keys {
  static let snapshot = "nextUp.snapshot"
  static let token = "nextUp.token"
  static let apiOrigin = "nextUp.apiOrigin"
  static let webOrigin = "nextUp.webOrigin"
}

struct NextUpAppointment: Codable, Hashable {
  let id: String
  let startsAt: Date
  let endsAt: Date
  /// The client's first name; nil when the barber hides names.
  let client: String?
  let service: String
  let chair: String
}

struct NextUpSnapshot: Codable {
  struct Shop: Codable {
    let name: String
    let timezone: String
  }
  let shop: Shop
  let showNames: Bool
  let appointments: [NextUpAppointment]
}

enum FetchResult {
  case fresh(NextUpSnapshot)
  case signedOut
  case unavailable
}

enum Store {
  static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { d in
      let container = try d.singleValueContainer()
      let text = try container.decode(String.self)
      let withFraction = ISO8601DateFormatter()
      withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = withFraction.date(from: text) { return date }
      let plain = ISO8601DateFormatter()
      plain.formatOptions = [.withInternetDateTime]
      if let date = plain.date(from: text) { return date }
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date: \(text)")
    }
    return decoder
  }

  static func cached() -> NextUpSnapshot? {
    guard let text = defaults?.string(forKey: Keys.snapshot), let data = text.data(using: .utf8) else { return nil }
    return try? decoder().decode(NextUpSnapshot.self, from: data)
  }

  static var webOrigin: String? { defaults?.string(forKey: Keys.webOrigin) }

  static func forget() {
    for key in [Keys.snapshot, Keys.token, Keys.apiOrigin, Keys.webOrigin] {
      defaults?.removeObject(forKey: key)
    }
  }

  /// Ask the API for a fresh snapshot with the widget's own token.
  static func fetch() async -> FetchResult {
    guard
      let token = defaults?.string(forKey: Keys.token),
      let origin = defaults?.string(forKey: Keys.apiOrigin),
      let url = URL(string: "\(origin)/api/next-up")
    else { return .unavailable }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 10
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse else { return .unavailable }
      if http.statusCode == 401 {
        forget()
        return .signedOut
      }
      guard http.statusCode == 200 else { return .unavailable }
      let snapshot = try decoder().decode(NextUpSnapshot.self, from: data)
      if let text = String(data: data, encoding: .utf8) {
        defaults?.set(text, forKey: Keys.snapshot)
      }
      return .fresh(snapshot)
    } catch {
      return .unavailable
    }
  }
}

struct NextUpEntry: TimelineEntry {
  enum Shows {
    case next(NextUpAppointment, timezone: String)
    case nobodyLeft(shop: String)
    case signedOut
    case setUp
  }
  let date: Date
  let shows: Shows
}

/// A client who is a few minutes late is still "next": the widget moves on 10
/// minutes after a start, not at the stroke of it.
let lateGrace: TimeInterval = 10 * 60
/// How often the widget asks for a fresh snapshot (WidgetKit budgets refreshes).
let refreshEvery: TimeInterval = 30 * 60

func entries(for snapshot: NextUpSnapshot, from now: Date) -> [NextUpEntry] {
  let upcoming = snapshot.appointments
    .filter { $0.startsAt.addingTimeInterval(lateGrace) > now }
    .sorted { $0.startsAt < $1.startsAt }
  // One entry now, then one each time the current "next" stops being next.
  var moments: [Date] = [now]
  for appt in upcoming {
    let flip = appt.startsAt.addingTimeInterval(lateGrace)
    if flip > now { moments.append(flip) }
  }
  return moments.prefix(24).map { moment in
    if let next = upcoming.first(where: { $0.startsAt.addingTimeInterval(lateGrace) > moment }) {
      return NextUpEntry(date: moment, shows: .next(next, timezone: snapshot.shop.timezone))
    }
    return NextUpEntry(date: moment, shows: .nobodyLeft(shop: snapshot.shop.name))
  }
}

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> NextUpEntry {
    NextUpEntry(
      date: Date(),
      shows: .next(
        NextUpAppointment(
          id: "placeholder",
          startsAt: Date().addingTimeInterval(1800),
          endsAt: Date().addingTimeInterval(3600),
          client: "Sam",
          service: "Fade",
          chair: ""
        ),
        timezone: TimeZone.current.identifier
      )
    )
  }

  func getSnapshot(in context: Context, completion: @escaping (NextUpEntry) -> Void) {
    if context.isPreview {
      completion(placeholder(in: context))
      return
    }
    let now = Date()
    if let cached = Store.cached(), let first = entries(for: cached, from: now).first {
      completion(first)
    } else {
      completion(NextUpEntry(date: now, shows: .setUp))
    }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<NextUpEntry>) -> Void) {
    Task {
      let now = Date()
      var list: [NextUpEntry]
      switch await Store.fetch() {
      case .fresh(let snapshot):
        list = entries(for: snapshot, from: now)
      case .signedOut:
        list = [NextUpEntry(date: now, shows: .signedOut)]
      case .unavailable:
        // No signal: keep showing what the app last gave us.
        if let cached = Store.cached() {
          list = entries(for: cached, from: now)
        } else {
          list = [NextUpEntry(date: now, shows: .setUp)]
        }
      }
      if list.isEmpty { list = [NextUpEntry(date: now, shows: .setUp)] }
      completion(Timeline(entries: list, policy: .after(now.addingTimeInterval(refreshEvery))))
    }
  }
}

func timeLabel(_ date: Date, timezone: String, now: Date = Date()) -> String {
  let zone = TimeZone(identifier: timezone) ?? .current
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = zone
  let time = DateFormatter()
  time.timeZone = zone
  time.dateFormat = "h:mm a"
  let clock = time.string(from: date)
  if calendar.isDate(date, inSameDayAs: now) { return clock }
  if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
    return "Tomorrow \(clock)"
  }
  let day = DateFormatter()
  day.timeZone = zone
  day.dateFormat = "EEE"
  return "\(day.string(from: date)) \(clock)"
}

/// Tapping the widget opens that booking, the way a tapped alert does
/// (app/barber.tsx reads `next`, src/pushTap.ts safeDashboardPath checks it).
func link(for appt: NextUpAppointment, timezone: String) -> URL? {
  let zone = TimeZone(identifier: timezone) ?? .current
  let dayFormat = DateFormatter()
  dayFormat.timeZone = zone
  dayFormat.locale = Locale(identifier: "en_US_POSIX")
  dayFormat.dateFormat = "yyyy-MM-dd"
  let path = "/dashboard/booking?tab=Appointments&appointment=\(appt.id)&day=\(dayFormat.string(from: appt.startsAt))"
  var components = URLComponents()
  components.scheme = "chairback"
  components.host = "barber"
  components.queryItems = [URLQueryItem(name: "next", value: path)]
  return components.url
}

struct NextUpView: View {
  @Environment(\.widgetFamily) var family
  let entry: NextUpEntry

  var body: some View {
    switch entry.shows {
    case .next(let appt, let timezone):
      let when = timeLabel(appt.startsAt, timezone: timezone, now: entry.date)
      let who = appt.client ?? appt.service
      switch family {
      case .accessoryInline:
        Text("Next: \(who) · \(when)")
          .widgetURL(link(for: appt, timezone: timezone))
      case .accessoryRectangular:
        VStack(alignment: .leading, spacing: 1) {
          Text("NEXT · \(when)").font(.caption2).fontWeight(.semibold).widgetAccentable()
          Text(who).font(.headline).lineLimit(1)
          if appt.client != nil {
            Text(appt.service).font(.caption).lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(link(for: appt, timezone: timezone))
      default:
        VStack(alignment: .leading, spacing: 4) {
          Text("NEXT UP").font(.caption2).fontWeight(.semibold).foregroundStyle(.secondary)
          Text(when).font(.title3).fontWeight(.semibold)
          Text(who).font(.headline).lineLimit(1)
          if appt.client != nil {
            Text(appt.service).font(.caption).foregroundStyle(.secondary).lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(link(for: appt, timezone: timezone))
      }
    case .nobodyLeft(let shop):
      message(title: "No one else today", detail: shop)
    case .signedOut:
      message(title: "Signed out", detail: "Sign in to ChairBack")
    case .setUp:
      message(title: "Next up", detail: "Open ChairBack to set up")
    }
  }

  @ViewBuilder
  func message(title: String, detail: String) -> some View {
    switch family {
    case .accessoryInline:
      Text(title)
    default:
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.headline).lineLimit(1)
        Text(detail).font(.caption).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

extension View {
  /// iOS 17 requires a container background on every widget; earlier
  /// versions don't have the API.
  @ViewBuilder
  func nextUpBackground() -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      self.containerBackground(for: .widget) { Color.clear }
    } else {
      self
    }
  }
}

struct NextUpWidget: Widget {
  let kind = "NextUp"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: Provider()) { entry in
      NextUpView(entry: entry).nextUpBackground()
    }
    .configurationDisplayName("Next up")
    .description("Your next client, on your Lock Screen.")
    .supportedFamilies([.accessoryRectangular, .accessoryInline, .systemSmall])
  }
}

@main
struct NextUpWidgets: WidgetBundle {
  var body: some Widget {
    NextUpWidget()
  }
}
