/**
 * Step-by-step DNS instructions for the companies owners actually buy domains
 * from, behind the "Step-by-step" button on the domain card.
 *
 * WHY PER REGISTRAR. The records are the same everywhere; what differs is
 * everything around them - where DNS lives in the menus, whether the root is
 * written `@` or left blank, what the value field is called, and which
 * default record is squatting on the name you need. Three of three owners who
 * connected a domain in production never finished, and every one of those
 * differences is a place to stop: GoDaddy's forwarding re-adds its own
 * records, Namecheap's parking CNAME already owns www, Cloudflare's orange
 * cloud hides the address we check for.
 *
 * 🔴 KEEP THE CLAIMS STABLE. Menus move. Every step names the concept (the
 * DNS page, the A record on the root) and the few labels that have been
 * stable for years; nothing depends on a screenshot or a URL we would have to
 * keep chasing.
 */

export type RegistrarId =
  | "godaddy"
  | "namecheap"
  | "cloudflare"
  | "squarespace"
  | "wix"
  | "porkbun"
  | "ionos"
  | "other";

export interface RegistrarGuide {
  id: RegistrarId;
  /** As the company writes its own name. */
  name: string;
  /** What this company calls the Name field - the table column header. */
  nameLabel: string;
  /**
   * How the bare domain is written in the Name field. `""` means leave the
   * field EMPTY, which some companies require and which reads as "I forgot"
   * unless it is said out loud.
   */
  root: "@" | "";
  /** In order. The records table is shown after these. */
  steps: readonly string[];
  /** The mistakes that cost people the most at this company. */
  watchOut: readonly string[];
  /** A note under the A and CNAME rows, where a setting on the row matters. */
  pointerRowNote?: string;
}

export const REGISTRAR_GUIDES: readonly RegistrarGuide[] = [
  {
    id: "godaddy",
    name: "GoDaddy",
    nameLabel: "Name",
    root: "@",
    steps: [
      "Sign in, open My Products, and choose DNS next to your domain.",
      "If the domain has Forwarding turned on, delete the forward first. While it is on, GoDaddy keeps putting its own records back.",
      "Find the A record named @ (it often says Parked). Tap the pencil and change its value. Edit it rather than adding a second one; that is what causes the conflict warning.",
      "Delete any other A records named @, so ours is the only one.",
      "Edit the CNAME named www the same way.",
      "Tap Add New Record for the TXT. It goes on @ too, next to any TXT records already there.",
      "For TTL, choose 1/2 Hour, or Custom and 600.",
    ],
    watchOut: [
      "If GoDaddy asks \"Looks like you're putting the domain in the Name field\", choose the first option (\"Yes, change it…\").",
    ],
  },
  {
    id: "namecheap",
    name: "Namecheap",
    nameLabel: "Host",
    root: "@",
    steps: [
      "Sign in, open Domain List, and click Manage next to your domain.",
      "Open the Advanced DNS tab.",
      "Delete the parking records Namecheap adds by default: a CNAME on www pointing to parkingpage.namecheap.com, and any URL Redirect Record.",
      "Click Add New Record for each record below.",
      "Click the green check mark on each row to save it. TTL can stay Automatic.",
    ],
    watchOut: [
      "Namecheap adds your domain to the Host for you. Type exactly what is shown - never your full domain, or it ends up written twice.",
      "No Host Records section on Advanced DNS means your domain uses another company's nameservers. The records go there instead.",
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    nameLabel: "Name",
    root: "@",
    steps: [
      "Sign in, choose your domain, then DNS and Records.",
      "Delete or edit any A, AAAA or CNAME record already on your domain itself (shown as @ or as your domain) and on www.",
      "Click Add record for each record below. The value goes in IPv4 address for the A record, Target for the CNAME, and Content for the TXT.",
      "Set Proxy status to DNS only - the grey cloud - on the A and the CNAME. TTL can stay Auto.",
    ],
    watchOut: [
      "The orange cloud must be off. While it is on, Cloudflare hides where your domain points, so we cannot see your records and your secure (https) certificate cannot be issued.",
    ],
    pointerRowNote: "Proxy status: DNS only (grey cloud)",
  },
  {
    id: "squarespace",
    name: "Squarespace",
    nameLabel: "Host",
    root: "@",
    steps: [
      "Sign in, open Domains, choose your domain, then DNS and DNS Settings.",
      "If there is a Squarespace Defaults section, delete it - its records on @ and www are in the way of ours.",
      "Under Custom records, click Add record for each record below. The value goes in Data.",
    ],
    watchOut: [
      "If this domain shows a Squarespace website today, removing Squarespace Defaults stops the domain showing that site. That is what connecting it here does anyway.",
      "Bought it through Google Domains? Those domains are managed at Squarespace now - this is the right guide.",
    ],
  },
  {
    id: "wix",
    name: "Wix",
    nameLabel: "Host Name",
    root: "",
    steps: [
      "Sign in, go to Domains, click the three dots next to your domain, then Manage DNS Records.",
      "In the A (Host) section, edit the record for your domain itself and change its value. Delete any other A records for the domain itself.",
      "In the CNAME (Aliases) section, edit www the same way.",
      "In the TXT section, click Add Record. Leave Host Name empty, like the A record.",
    ],
    watchOut: [
      "If the domain is attached to a Wix site, Wix may warn that changing these records disconnects it. That is expected - your page here takes its place.",
      "This only works if your domain's DNS is at Wix - you bought it there, or pointed it there.",
    ],
  },
  {
    id: "porkbun",
    name: "Porkbun",
    nameLabel: "Host",
    root: "",
    steps: [
      "Sign in, go to Domain Management, and open the DNS records for your domain.",
      "Delete Porkbun's parking records: the ALIAS on your domain itself, and any CNAME pointing to pixie.porkbun.com.",
      "Add each record below. The value goes in Answer.",
    ],
    watchOut: [
      "Leave Host empty for the A and TXT records - do not type @.",
    ],
  },
  {
    id: "ionos",
    name: "IONOS",
    nameLabel: "Host name",
    root: "@",
    steps: [
      "Sign in, open Domains & SSL, click the gear next to your domain, then DNS.",
      "Edit the A record for @ and change where it points. Delete the AAAA record for @ if there is one.",
      "Edit or add the CNAME for www. If www has an A or AAAA record, delete it first - a name cannot have both.",
      "Add the TXT record. If IONOS offers to replace conflicting records, accept.",
    ],
    watchOut: [
      "Leave an AAAA record on @ and visitors on newer networks keep landing on the old page.",
    ],
  },
  {
    id: "other",
    name: "Somewhere else",
    nameLabel: "Name / Host",
    root: "@",
    steps: [
      "Sign in where your domain's DNS is managed, and look for DNS, DNS Records, Zone Editor or Advanced DNS.",
      "Edit the A record on your domain itself (@, or blank) rather than adding a second one. Delete any AAAA records on @ and on www.",
      "Point www at the CNAME value, deleting any A record on www first.",
      "Add the TXT record on @, alongside any TXT records already there.",
      "Turn off any forwarding, redirect or parking the company offers on the domain.",
      "For TTL, use the lowest it allows, or its default.",
    ],
    watchOut: [
      "Type only what is shown in the Name column - the company adds your domain itself. Some want the field left blank instead of @.",
    ],
  },
];

/** Advice that holds at every company, shown under whichever guide is open. */
export const EVERYWHERE: readonly string[] = [
  "Leave MX records alone, and any TXT record starting v=spf1 - those are your email.",
  "Changes usually show up within a few minutes. Then come back and tap check again.",
];

/**
 * A record name as the owner should TYPE it: relative to their own domain.
 * `_vercel.example.com` on example.com is `_vercel`; the domain itself is `@`.
 *
 * 🔴 Showing a fully-qualified name is how a registrar that appends the domain
 * itself (Namecheap, and GoDaddy unless it happens to ask first) ends up
 * storing `_vercel.example.com.example.com`, which never resolves - and the
 * owner, having typed exactly what they were shown, has no way to see why.
 * A name that is not under the domain is returned unchanged, since shortening
 * it would point somewhere else entirely.
 */
export function relativeRecordName(name: string, domain: string | null): string {
  const n = name.trim().replace(/\.$/, "").toLowerCase();
  if (n === "@" || n === "") return "@";
  if (!domain) return n;
  const d = domain.trim().replace(/\.$/, "").toLowerCase();
  if (n === d) return "@";
  if (n.endsWith(`.${d}`)) return n.slice(0, -(d.length + 1));
  return n;
}

/**
 * What to type in THIS company's Name field for a record. The root becomes
 * `@` or `""` (leave it blank) by the company's own rule; everything else is
 * the relative name.
 */
export function hostFor(guide: RegistrarGuide, name: string, domain: string | null): string {
  const rel = relativeRecordName(name, domain);
  return rel === "@" ? guide.root : rel;
}

export function guideById(id: RegistrarId): RegistrarGuide {
  const g = REGISTRAR_GUIDES.find((x) => x.id === id);
  if (!g) throw new Error(`unknown registrar ${id}`);
  return g;
}
