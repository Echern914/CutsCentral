/**
 * The help bot's answer engine: turn whatever a barber typed into the best
 * written answer we have, synchronously, with no network call.
 *
 * THE CONTRACT — `findHelp()` never returns nothing. Either it's confident
 * enough to lead with one answer, or it hands back the closest topics plus the
 * route to a human. There is no "sorry, I didn't understand that" branch,
 * because a dead end is the one outcome that makes a help bot worse than no
 * help bot. The return type enforces it: `suggestions` is always non-empty.
 *
 * HOW MATCHING WORKS, cheapest signal first:
 *  - normalize + tokenize, dropping stopwords and plural 's'
 *  - expand a few tokens through SYNONYMS ("txt" → "text", "cost" → "price"),
 *    at a discount, so a synonym hit never outranks the real word
 *  - score each entry: a hit in the QUESTION beats a hit in KEYWORDS beats a
 *    hit in the body, and near-misses (one or two typo'd characters) score at
 *    a discount so "aquity" and "cancle" still land
 *  - weight by COVERAGE, so matching 3 of a barber's 3 words beats matching
 *    3 of 9 — otherwise long entries win every long query
 *  - a literal phrase hit on the question is worth more than any of it
 *
 * Every FEATURE_INDEX entry is folded into the corpus as a "where do I find X"
 * answer, so the whole feature directory is askable without duplicating it in
 * help.ts. Its hand-written synonyms are exactly the vocabulary we want.
 */

import {
  FEATURE_INDEX,
  isBillingHref,
  type FeatureCategoryId,
  type FeatureIndexEntry,
} from "./features.js";
import { PLANS } from "./constants.js";
import { HELP_ANSWERS, type HelpAnswer, type HelpCategoryId } from "./help.js";

/* =============================== tokenizing ============================== */

/** Words that carry no signal in a support question. */
const STOPWORDS = new Set([
  "a", "about", "am", "an", "and", "any", "are", "as", "at", "be", "been", "but",
  "by", "can", "could", "did", "do", "does", "doing", "dont", "for", "from",
  "get", "got", "had", "has", "have", "how", "i", "if", "in", "into", "is",
  "it", "its", "just", "me", "my", "need", "of", "on", "or", "our", "out",
  "please", "should", "so", "some", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "up", "us", "was", "we",
  "were", "what", "when", "where", "which", "who", "why", "will", "with",
  "would", "you", "your", "im", "ive", "id", "whats", "hows", "theres",
  // Pronouns are pure noise in a support question, but they were inflating the
  // token count and pushing real matches under the coverage bar — "my client
  // says she didn't get her text" scored 3 hits out of 6 "words" instead of 4.
  "he", "she", "her", "him", "his", "hers", "theirs", "someone", "somebody",
]);

/**
 * Alternate vocabulary folded in at a discount. Only real synonyms belong here
 * — typos are the fuzzy matcher's job, and putting them here would let a
 * misspelling score as an exact hit.
 */
const SYNONYMS: Record<string, string[]> = {
  txt: ["text"],
  sms: ["text", "message"],
  msg: ["text", "message"],
  texting: ["text"],
  cost: ["price"],
  pricing: ["price"],
  charge: ["price", "payment"],
  expensive: ["price"],
  cheap: ["price"],
  afford: ["price"],
  fee: ["price", "commission"],
  cut: ["commission", "haircut"],
  percent: ["commission"],
  percentage: ["commission"],
  subscribe: ["subscription", "plan"],
  unsubscribe: ["cancel"],
  quit: ["cancel", "delete"],
  stop: ["cancel", "opt"],
  end: ["cancel"],
  remove: ["delete"],
  erase: ["delete"],
  money: ["payment", "revenue"],
  paid: ["payment"],
  pay: ["payment"],
  payout: ["payment"],
  bank: ["payment", "payout"],
  card: ["payment", "punch"],
  stamp: ["punch"],
  loyalty: ["punch", "reward"],
  client: ["customer"],
  customer: ["client"],
  barber: ["staff"],
  stylist: ["staff"],
  employee: ["staff", "team"],
  worker: ["staff"],
  calendar: ["booking", "schedule"],
  appointment: ["booking"],
  appt: ["booking", "appointment"],
  slot: ["booking", "time"],
  availability: ["hour", "schedule"],
  open: ["hour", "availability"],
  photo: ["gallery", "picture"],
  pic: ["photo", "gallery"],
  logo: ["branding", "theme"],
  colour: ["color", "theme"],
  site: ["page", "website"],
  website: ["page", "site"],
  link: ["page", "booking"],
  ai: ["receptionist"],
  bot: ["receptionist"],
  robot: ["receptionist"],
  noshow: ["reminder"],
  reschedule: ["cancel", "booking"],
  refund: ["billing"],
  invoice: ["billing"],
  receipt: ["billing"],
  signin: ["login"],
  signup: ["login", "account"],
  password: ["login"],
  data: ["privacy", "export"],
  safe: ["privacy", "security"],
  secure: ["privacy", "security"],
};

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Strip a trailing plural 's' so "hours" and "hour" are the same token. */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  for (const raw of normalize(input).split(" ")) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const t = stem(raw);
    if (t.length < 2) continue;
    out.push(t);
  }
  return out;
}

/** Query tokens, plus synonym expansions flagged so they score at a discount. */
function expandQuery(input: string): { token: string; weight: number }[] {
  const base = tokenize(input);
  const seen = new Set(base);
  const out = base.map((token) => ({ token, weight: 1 }));
  for (const t of base) {
    for (const syn of SYNONYMS[t] ?? []) {
      const s = stem(syn);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({ token: s, weight: 0.65 });
    }
  }
  return out;
}

/* ============================ fuzzy comparison =========================== */

/**
 * Damerau-Levenshtein (optimal string alignment), abandoned as soon as it
 * can't come in at or under `max`.
 *
 * The TRANSPOSITION case is the whole reason this isn't plain Levenshtein:
 * swapped adjacent letters are the most common typo there is, and plain
 * Levenshtein charges 2 edits for one. "cancle" → "cancel" is a single
 * mistake and has to score like one, or every fat-fingered query falls through
 * to the closest-topics branch.
 */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Three rows: i-2 is needed to price a transposition.
  let prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowBest = curr[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2]! + 1);
      }
      curr[j] = d;
      if (d < rowBest) rowBest = d;
    }
    if (rowBest > max) return max + 1;
    const recycled = prev2;
    prev2 = prev;
    prev = curr;
    curr = recycled;
  }
  return prev[b.length]!;
}

/** How many characters of slop a token of this length earns. */
function slopFor(len: number): number {
  if (len >= 7) return 2;
  if (len >= 4) return 1;
  return 0;
}

/* ============================== the corpus =============================== */

const FEATURE_TO_HELP_CATEGORY: Record<FeatureCategoryId, HelpCategoryId> = {
  booking: "booking",
  money: "money",
  retention: "clients",
  brand: "brand",
  data: "clients",
  account: "account",
};

/**
 * A feature-directory entry as an answer. Deliberately thin: it says what the
 * feature is and hands over a button, because the index's `description` is the
 * one sentence we've already committed to for that feature everywhere else.
 */
function featureAnswer(f: FeatureIndexEntry): HelpAnswer {
  // Label-only plan mention for tiered features: names the plan, quotes no
  // price and steers nowhere, so it is safe inside the native shell too.
  const tierNote = f.tier ? `\n\nPart of the ${PLANS[f.tier].name} plan.` : "";
  return {
    id: `feature-${f.id}`,
    q: `Where do I find ${f.name}?`,
    a: `${f.description}.\n\nIt's under ${f.name} in your dashboard — the button below opens it.${tierNote}`,
    keywords: [f.name, ...f.synonyms],
    category: FEATURE_TO_HELP_CATEGORY[f.category],
    // Matches the shared 3.1.1 rule: anything landing on the subscription page
    // is a back door onto a purchase flow Apple forbids in-app.
    action: { label: `Open ${f.name}`, featureId: f.id },
    hidesInApp: isBillingHref(f.href),
  };
}

/**
 * Curated answers first: on a tie, a hand-written how/why answer beats the
 * generated "here's where that lives" one.
 */
export const HELP_CORPUS: HelpAnswer[] = [
  ...HELP_ANSWERS,
  // Unlisted entries (the public marketing pages) are resolvable destinations,
  // not shop features, so they get no generated "where do I find X" answer.
  ...FEATURE_INDEX.filter((f) => f.listed !== false).map(featureAnswer),
];

interface Indexed {
  entry: HelpAnswer;
  primaryTokens: Set<string>;
  questionTokens: Set<string>;
  keywordTokens: Set<string>;
  bodyTokens: Set<string>;
  /** Question + keywords, for fuzzy scanning. Body is excluded: too noisy. */
  fuzzyTokens: string[];
  normalizedQuestion: string;
  normalizedKeywords: string;
}

/** Tokenized once at module load — the corpus is static. */
const INDEXED: Indexed[] = HELP_CORPUS.map((entry) => {
  const questionTokens = new Set(tokenize(entry.q));
  const keywordTokens = new Set(entry.keywords.flatMap((k) => tokenize(k)));
  const bodyTokens = new Set(tokenize(entry.a));
  const primaryTokens = new Set((entry.primaryFor ?? []).flatMap((k) => tokenize(k)));
  return {
    entry,
    primaryTokens,
    questionTokens,
    keywordTokens,
    bodyTokens,
    fuzzyTokens: [...new Set([...questionTokens, ...keywordTokens])],
    normalizedQuestion: normalize(entry.q),
    normalizedKeywords: entry.keywords.map((k) => normalize(k)).join(" | "),
  };
});

/* =============================== scoring ================================= */

/** A declared `primaryFor` word outranks any incidental mention of it. */
const HIT_PRIMARY = 4;
const HIT_QUESTION = 3;
const HIT_KEYWORD = 2.6;
const HIT_BODY = 1;
const HIT_FUZZY = 1.7;

/** Whole query appears verbatim in the question / a keyword. */
const PHRASE_QUESTION_BONUS = 6;
const PHRASE_KEYWORD_BONUS = 4.5;
/**
 * CONFIDENCE. Getting this wrong in the loose direction is the worst thing this
 * file can do: a confidently WRONG answer is worse than an honest "here's the
 * closest I've got", because the barber acts on it. So the bar is deliberately
 * asymmetric, and it is not one number.
 *
 * A one-word query ("waitlist", "refund") is unambiguous — an exact hit on the
 * question or keywords IS the answer, and shrugging at it would be absurd.
 *
 * A multi-word query is where the trap lives. Stripping stopwords turns "how do
 * I get more clients" into ["more", "client"], and a single incidental hit on
 * "client" then looks like total coverage. So longer queries must clear all
 * three: most of their real words addressed, a decent total, and at least one
 * EXACT hit — a pile of fuzzy near-misses never adds up to certainty.
 */
const CONFIDENT_SCORE_MULTI = 3.4;
const CONFIDENT_COVERAGE_MULTI = 0.6;
/** An exact hit on question/keyword/primary — not merely a typo-tolerant one. */
const EXACT_HIT_MIN = HIT_KEYWORD;

function scoreEntry(
  idx: Indexed,
  query: { token: string; weight: number }[],
  normalizedQuery: string,
): { score: number; coverage: number; bestHit: number; realTokens: number } {
  let sum = 0;
  let matched = 0;
  let realTokens = 0;
  let bestHit = 0;

  for (const { token, weight } of query) {
    if (weight === 1) realTokens++;
    let best = 0;
    if (idx.primaryTokens.has(token)) best = HIT_PRIMARY;
    else if (idx.questionTokens.has(token)) best = HIT_QUESTION;
    else if (idx.keywordTokens.has(token)) best = HIT_KEYWORD;
    else if (idx.bodyTokens.has(token)) best = HIT_BODY;
    else {
      const slop = slopFor(token.length);
      if (slop > 0) {
        for (const candidate of idx.fuzzyTokens) {
          if (Math.abs(candidate.length - token.length) > slop) continue;
          if (editDistance(token, candidate, slop) <= slop) {
            best = HIT_FUZZY;
            break;
          }
        }
      }
    }
    if (best > 0) {
      sum += best * weight;
      if (weight === 1) {
        matched++;
        if (best > bestHit) bestHit = best;
      }
    }
  }

  // Coverage over the barber's OWN words, not the synonym-expanded set: a
  // question is answered when its real words are addressed.
  const coverage = realTokens === 0 ? 0 : matched / realTokens;
  let score = sum * (0.5 + 0.5 * coverage);

  if (normalizedQuery.length >= 5) {
    if (idx.normalizedQuestion.includes(normalizedQuery)) score += PHRASE_QUESTION_BONUS;
    else if (idx.normalizedKeywords.includes(normalizedQuery)) score += PHRASE_KEYWORD_BONUS;
  }

  return { score, coverage, bestHit, realTokens };
}

/* ================================ the API ================================ */

export interface HelpResponse {
  /**
   * `answer` — we're confident, lead with `answer` and offer `suggestions` as
   * follow-ups. `suggestions` — we're not, so `answer` is null and
   * `suggestions` is the closest we've got. Never empty in either case.
   */
  kind: "answer" | "suggestions";
  answer: HelpAnswer | null;
  suggestions: HelpAnswer[];
}

/** Shown when a query matches literally nothing — the questions asked most. */
const FALLBACK_IDS = [
  "get-started",
  "pricing",
  "how-booking-works",
  "punch-cards",
  "contact-human",
];

const MAX_SUGGESTIONS = 4;

export interface FindHelpOptions {
  /**
   * Inside the iOS/Android shell. Drops price-quoting and billing-steering
   * answers from the corpus entirely (App Store Guideline 3.1.1) — they must
   * not be reachable by typing, not merely hidden from the starter chips.
   */
  inApp?: boolean;
}

/**
 * The single entry point. Always resolves to something useful — see the
 * contract at the top of this file.
 */
export function findHelp(query: string, opts: FindHelpOptions = {}): HelpResponse {
  const pool = opts.inApp ? INDEXED.filter((i) => !i.entry.hidesInApp) : INDEXED;
  const expanded = expandQuery(query);
  const normalizedQuery = normalize(query);

  const scored =
    expanded.length === 0
      ? []
      : pool
          .map((idx) => ({ idx, ...scoreEntry(idx, expanded, normalizedQuery) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const confident = top !== undefined && isConfident(top);

  if (confident) {
    return {
      kind: "answer",
      answer: top.idx.entry,
      suggestions: scored.slice(1, 1 + MAX_SUGGESTIONS).map((r) => r.idx.entry),
    };
  }

  // Not confident — hand back the closest topics. If nothing scored at all,
  // fall back to the most-asked questions so the reply is still a way forward.
  const closest = scored.slice(0, MAX_SUGGESTIONS).map((r) => r.idx.entry);
  const suggestions = closest.length > 0 ? closest : fallbackAnswers(pool);
  return { kind: "suggestions", answer: null, suggestions };
}

/** See the CONFIDENCE note above — one rule for one-word queries, one for the rest. */
function isConfident(r: {
  score: number;
  coverage: number;
  bestHit: number;
  realTokens: number;
}): boolean {
  if (r.realTokens === 0) return false;
  if (r.realTokens === 1) return r.bestHit >= EXACT_HIT_MIN;
  // The exact-hit requirement exists to reject SCATTERED fuzzy noise, not
  // complete fuzzy coverage: "chagne my passwrd" has no exact hit anywhere and
  // is still unmistakably about changing a password. Total coverage is its own
  // evidence, so it stands in for the exact hit.
  const notJustNoise = r.bestHit >= EXACT_HIT_MIN || r.coverage === 1;
  return (
    r.coverage >= CONFIDENT_COVERAGE_MULTI &&
    r.score >= CONFIDENT_SCORE_MULTI &&
    notJustNoise
  );
}

function fallbackAnswers(pool: Indexed[]): HelpAnswer[] {
  const byId = new Map(pool.map((i) => [i.entry.id, i.entry]));
  const picked = FALLBACK_IDS.map((id) => byId.get(id)).filter(
    (e): e is HelpAnswer => e !== undefined,
  );
  // Belt and braces: the contract says non-empty, so never trust the ids alone.
  return picked.length > 0 ? picked : pool.slice(0, MAX_SUGGESTIONS).map((i) => i.entry);
}

/** Look an answer up by id — used when a suggestion chip is tapped. */
/* ========================= feature-directory search ====================== */

/**
 * Keyword search over FEATURE_INDEX, for the Cmd-K palette.
 *
 * The palette used to score by whole-query SUBSTRING: `name.startsWith(q)` >
 * `name.includes(q)` > synonym > description. Measured against the real index,
 * that returned NOTHING for 37 of 46 things a barber would actually type -
 * buffer, lunch break, no show, block off, timezone, csv, acuity, qr code,
 * card punch - while confidently returning garbage for others, because a bare
 * substring matches inside words: "age" hit "Public shop p-AGE" (10 results,
 * top-ranked), "tip" hit "mul-TIP-le", "ical" hit "automat-ICAL-ly".
 *
 * Three things were wrong and all three are fixed by matching TOKENS, not
 * substrings:
 *  1. no tokenization - "punch card" matched and "card punch" did not, because
 *     the whole query had to appear as one contiguous run of characters.
 *  2. no word boundaries - hence age/tip/ical.
 *  3. no typo tolerance - "waitlst" found nothing, while the CLIENT search two
 *     screens away finds "José" from "Jose".
 *
 * Deliberately shares this file's tokenizer, stemmer, synonym table and
 * Damerau distance with findHelp rather than growing a second dialect: a
 * barber who types "cancle" into the help bubble and the palette should not
 * get two different qualities of answer.
 *
 * AND semantics: every real query token must hit something, so "punch card"
 * cannot match an entry that only knows "card". Ranking is field-weighted -
 * name beats synonym beats description - and a fuzzy hit always scores below
 * an exact one, so typo tolerance can never outrank a real match.
 */
export interface FeatureHit {
  entry: FeatureIndexEntry;
  score: number;
}

/** Field weights. A name hit is worth more than a description hit. */
const FIELD_WEIGHT = { name: 3, synonym: 2, description: 1 } as const;

function tokenSetFor(f: FeatureIndexEntry): {
  name: Set<string>;
  synonym: Set<string>;
  description: Set<string>;
} {
  return {
    name: new Set(tokenize(f.name)),
    synonym: new Set(f.synonyms.flatMap((s) => tokenize(s))),
    description: new Set(tokenize(f.description)),
  };
}

/** Best score for one query token against one field's token set. */
function hitScore(token: string, field: Set<string>, weight: number): number {
  if (field.has(token)) return weight;
  // Prefix match: "cancel" should find "cancellation" without a synonym entry.
  for (const t of field) {
    if (t.length > token.length && t.startsWith(token) && token.length >= 4) {
      return weight * 0.9;
    }
  }
  // Fuzzy last, and always below an exact hit of the SAME weight so a typo can
  // never beat a real match.
  const slop = slopFor(token.length);
  if (slop > 0) {
    for (const t of field) {
      if (Math.abs(t.length - token.length) > slop) continue;
      if (editDistance(token, t, slop) <= slop) return weight * 0.6;
    }
  }
  return 0;
}

export function searchFeatures(
  query: string,
  index: readonly FeatureIndexEntry[],
): FeatureHit[] {
  const expanded = expandQuery(query);
  if (expanded.length === 0) return [];
  // Only unweighted (i.e. literally typed) tokens are REQUIRED. A synonym
  // expansion is a bonus; demanding it would make the AND rule stricter than
  // what the barber actually typed.
  const required = expanded.filter((t) => t.weight === 1).map((t) => t.token);

  const hits: FeatureHit[] = [];
  for (const entry of index) {
    const fields = tokenSetFor(entry);
    let score = 0;
    let matchedRequired = 0;
    for (const { token, weight } of expanded) {
      const best = Math.max(
        hitScore(token, fields.name, FIELD_WEIGHT.name),
        hitScore(token, fields.synonym, FIELD_WEIGHT.synonym),
        hitScore(token, fields.description, FIELD_WEIGHT.description),
      );
      if (best > 0) {
        score += best * weight;
        if (weight === 1) matchedRequired++;
      }
    }
    // AND: every typed token has to land somewhere on this entry.
    if (required.length > 0 && matchedRequired < required.length) continue;
    if (score <= 0) continue;

    // PHRASE BONUS. Per-token scoring alone lets one strong token beat an
    // entry that spells the whole phrase out: "time off" scored higher on
    // "Time zone" (name hit on "time") than on Staff, whose synonym is
    // literally "time off"; "walk in" preferred "Dashboard walkthrough"
    // (prefix hit on "walk") over the entry that lists "walk in". An exact
    // multi-word synonym is the strongest signal in the index - somebody sat
    // down and wrote that phrase against that feature - so it has to outrank
    // an incidental single-token hit.
    const nq = normalize(query);
    if (nq) {
      if (normalize(entry.name) === nq) score += 10;
      else if (entry.synonyms.some((s) => normalize(s) === nq)) score += 8;
      else if (
        nq.includes(" ") &&
        (normalize(entry.name).includes(nq) ||
          entry.synonyms.some((s) => normalize(s).includes(nq)))
      ) {
        score += 4;
      }
    }
    hits.push({ entry, score });
  }
  return hits.sort(
    (a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name),
  );
}

export function helpAnswerById(id: string): HelpAnswer | undefined {
  return HELP_CORPUS.find((e) => e.id === id);
}
