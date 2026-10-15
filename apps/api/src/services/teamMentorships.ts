import { Prisma, runAsOwner } from "@chairback/db";
import { NOTHING_SHARED, sharingOf, teamNumbers, type Sharing, type TeamNumbers } from "./teamLinks.js";

/**
 * Mentorship on a team - the numbers half of Snow's ask (2026-10-15).
 *
 * The team's OWNER pairs a mentor with a student; both are members of the
 * team (ACTIVE TeamLinks). The mentor sees the student's numbers - ONLY the
 * ones the student shares with that mentor, every switch off to start, and
 * separate from what they share with the owner. Photo feedback lives in the
 * team's own chat; nothing here stores or shows a photo.
 *
 * 🔴 PRIVACY IS DECIDED HERE, by the same function the owner's view uses
 * (teamNumbers): a number not shared with this mentor is never computed.
 *
 * Either side can end a pairing. Leaving the team, or being removed, ends
 * every pairing that member is in (endMentorshipsForLink, in the same
 * transaction as the link ending).
 */

export type PairResult =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" | "same_person" | "already_paired" };

/** The team owner pairs `mentor` with `student`. Both must be on THIS team now. */
export async function pairMentor(input: {
  teamShopId: string;
  mentorLinkId: string;
  studentLinkId: string;
}): Promise<PairResult> {
  if (input.mentorLinkId === input.studentLinkId) return { ok: false, error: "same_person" };
  try {
    return await runAsOwner(async (tx) => {
      const members = await tx.teamLink.count({
        where: {
          id: { in: [input.mentorLinkId, input.studentLinkId] },
          teamShopId: input.teamShopId,
          status: "ACTIVE",
        },
      });
      if (members !== 2) return { ok: false as const, error: "not_found" as const };
      const live = await tx.teamMentorship.findFirst({
        where: { mentorLinkId: input.mentorLinkId, studentLinkId: input.studentLinkId, status: "ACTIVE" },
        select: { id: true },
      });
      if (live) return { ok: false as const, error: "already_paired" as const };
      const created = await tx.teamMentorship.create({
        data: {
          teamShopId: input.teamShopId,
          mentorLinkId: input.mentorLinkId,
          studentLinkId: input.studentLinkId,
        },
        select: { id: true },
      });
      return { ok: true as const, id: created.id };
    });
  } catch (err) {
    // A double tap: both saw no live pairing; the partial unique index refused the second.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "already_paired" };
    }
    throw err;
  }
}

/** End every live pairing a member is in, as mentor or student. In the caller's tx. */
export async function endMentorshipsForLink(tx: Prisma.TransactionClient, linkId: string): Promise<number> {
  const { count } = await tx.teamMentorship.updateMany({
    where: { status: "ACTIVE", OR: [{ mentorLinkId: linkId }, { studentLinkId: linkId }] },
    data: { status: "ENDED", endedAt: new Date(), ...NOTHING_SHARED },
  });
  return count;
}

/** One pairing as the team's owner sees it: who and since when - never numbers. */
export interface PairingForOwner {
  id: string;
  mentor: { linkId: string; name: string };
  student: { linkId: string; name: string };
  since: string;
}

export function pairingsForTeam(teamShopId: string): Promise<PairingForOwner[]> {
  return runAsOwner(async (tx) => {
    const rows = await tx.teamMentorship.findMany({
      where: { teamShopId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        createdAt: true,
        mentorLink: { select: { id: true, memberShop: { select: { name: true } } } },
        studentLink: { select: { id: true, memberShop: { select: { name: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      mentor: { linkId: r.mentorLink.id, name: r.mentorLink.memberShop.name },
      student: { linkId: r.studentLink.id, name: r.studentLink.memberShop.name },
      since: r.createdAt.toISOString(),
    }));
  });
}

/** A pairing where this member is the STUDENT: who sees what, and the preview. */
export interface MyMentor {
  id: string;
  mentor: { name: string };
  since: string;
  sharing: Sharing;
  /** Exactly what the mentor reads now - the same function their page calls. */
  theySee: TeamNumbers;
}

/** A pairing where this member is the MENTOR: the student's shared numbers. */
export interface MyStudent {
  id: string;
  student: { name: string };
  since: string;
  numbers: TeamNumbers;
}

/**
 * Both sides for one of this member's team links: the mentors they have (as
 * student) and the members they mentor. Numbers are read from the STUDENT's
 * own business, in their own timezone, and only what they share with this
 * mentor.
 */
export async function mentorshipsForMemberLink(
  linkId: string,
  now: Date = new Date(),
): Promise<{ mentors: MyMentor[]; mentoring: MyStudent[] }> {
  const rows = await runAsOwner((tx) =>
    tx.teamMentorship.findMany({
      where: { status: "ACTIVE", OR: [{ mentorLinkId: linkId }, { studentLinkId: linkId }] },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        createdAt: true,
        mentorLinkId: true,
        studentLinkId: true,
        shareCuts: true,
        shareRevenue: true,
        shareClients: true,
        shareRating: true,
        mentorLink: { select: { memberShop: { select: { name: true } } } },
        studentLink: { select: { memberShop: { select: { id: true, name: true, timezone: true } } } },
      },
    }),
  );
  const mentors: MyMentor[] = [];
  const mentoring: MyStudent[] = [];
  for (const r of rows) {
    const sharing = sharingOf(r);
    const numbers = await teamNumbers(r.studentLink.memberShop, sharing, now);
    if (r.studentLinkId === linkId) {
      mentors.push({
        id: r.id,
        mentor: { name: r.mentorLink.memberShop.name },
        since: r.createdAt.toISOString(),
        sharing,
        theySee: numbers,
      });
    } else {
      mentoring.push({
        id: r.id,
        student: { name: r.studentLink.memberShop.name },
        since: r.createdAt.toISOString(),
        numbers,
      });
    }
  }
  return { mentors, mentoring };
}
