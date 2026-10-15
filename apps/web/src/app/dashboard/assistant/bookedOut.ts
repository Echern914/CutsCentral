import type { BookedOutBrief } from "@chairback/config/bookedOut";
import { apiGet } from "@/lib/api";

/**
 * "How do I get booked out more?" for THIS shop - the brief the API computes
 * from the shop's own numbers (apps/api routes/bookedOut.ts).
 *
 * Fetched server-side by the Assistant page and handed to the ask field as a
 * live fact. Null on any failure: the question then gets the written answer,
 * which is general advice and never a wrong number. Nothing here computes a
 * signal; the API owns every number.
 */
export async function getBookedOut(): Promise<BookedOutBrief | null> {
  const res = await apiGet<{ brief: BookedOutBrief }>("/api/assistant/booked-out");
  return res.ok && res.data?.brief ? res.data.brief : null;
}
