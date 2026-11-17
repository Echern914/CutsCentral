import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { keepTokenPageOnDomain } from "@/lib/customDomainVisit";
import { GroupManageClient } from "./GroupManageClient";
import { groupViewAction } from "./actions";

/**
 * Managing a booked party, by its whole-group token.
 *
 * 🔴 `robots: noindex` AND NOTHING ELSE ABOUT THE TOKEN LEAVES THIS FILE. The
 * URL segment IS the credential: whoever holds it can move or cancel the whole
 * visit, and the payload carries each member's own manage token as well - so
 * one leaked link is the entire party. It is never logged (the API redacts
 * /api/book/group/<token> from its request log) and never put in a query
 * string where a Referer would carry it onward.
 */
export const metadata: Metadata = {
  title: `Your group · ${APP_NAME}`,
  robots: { index: false, follow: false },
};

export default async function GroupManagePage({
  params,
}: {
  params: { token: string };
}) {
  const res = await groupViewAction(params.token);
  // A bad token and a deleted group answer identically: a link that opens
  // nothing must not become a way to learn whether a party exists.
  if (!res.ok) notFound();
  // On a shop's own domain only that shop's party shows here; any other goes
  // to the same page on getchairback.com (lib/customDomainVisit.ts).
  await keepTokenPageOnDomain(res.group.shop.slug, `/book/group/${params.token}`);
  return <GroupManageClient token={params.token} initial={res.group} />;
}
