/**
 * The view the Calendar opens on when nobody has chosen one.
 *
 * A computer opens on the Week, which is the desk view the website shows. A
 * phone opens on the Month, as it always has: seven columns of names do not
 * fit it. This hint comes from the request, so a phone never paints a blank
 * week placeholder first. The calendar still measures the window: a computer
 * whose window is too narrow for the week gets the Month too.
 *
 * "Mobi" covers Android phones (an Android TABLET leaves it out, and gets the
 * week where it fits); iPhone and iPod cover iOS, including the ChairBack app.
 */
export function defaultCalendarView(userAgent: string | null | undefined): "week" | "month" {
  return /Mobi|iPhone|iPod/i.test(userAgent ?? "") ? "month" : "week";
}
