/**
 * One-shot probe: discover how Acuity returns intake-form answers (esp. a
 * consent checkbox) on appointments, so Phase B can parse them reliably.
 *
 * Decrypts the live connection's token locally (NEVER printed). Reads recent
 * appointments WITH pastFormAnswers and dumps the `forms` structure verbatim so
 * we can see the exact field name + the value encoding for checked vs unchecked.
 *
 * Run (only on explicit go-ahead):
 *   cd packages/db
 *   PROD_TOKEN_ENCRYPTION_KEY=<key> npx tsx prisma/probe-acuity-consent.ts
 *
 * The shopId below is the trial account "chernCuts" (Acuity 39574616).
 */
import { decrypt } from "@chairback/config";
import { prisma } from "../src/client.js";

const PROD_KEY = process.env.PROD_TOKEN_ENCRYPTION_KEY;
const SHOP_ID = process.env.PROBE_SHOP_ID ?? "cmq3ybnc1000213t45xm6g06a";
const API = "https://acuityscheduling.com/api/v1";

async function call(path: string, token: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 300);
  }
  return { status: res.status, json };
}

async function main() {
  if (!PROD_KEY) throw new Error("Set PROD_TOKEN_ENCRYPTION_KEY (see DEPLOY.md)");

  const conn = await prisma.acuityConnection.findUnique({
    where: { shopId: SHOP_ID },
    select: { accessToken: true, acuityAccountId: true },
  });
  if (!conn) throw new Error(`no Acuity connection for shop ${SHOP_ID}`);
  const token = decrypt(conn.accessToken, PROD_KEY);
  console.log(`probing Acuity account ${conn.acuityAccountId} for shop ${SHOP_ID}\n`);

  // 1) Latest appointments WITH form answers (newest first).
  const list = await call(
    "/appointments?max=10&direction=DESC&pastFormAnswers=true",
    token,
  );
  console.log(`GET /appointments (max=10, DESC, pastFormAnswers=true) -> ${list.status}`);
  if (list.status !== 200 || !Array.isArray(list.json)) {
    console.log("  unexpected response:", JSON.stringify(list.json).slice(0, 400));
    return;
  }

  const appts = list.json as Array<Record<string, unknown>>;
  console.log(`  ${appts.length} appointment(s) returned\n`);

  // 2) For each, dump just the identity + the `forms` block so we can read the
  //    exact shape (form id/name, values[].fieldID/name/value) and how a
  //    checkbox renders for checked vs unchecked.
  for (const a of appts) {
    const id = a.id;
    const who = `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim() || "(no name)";
    const when = a.datetime ?? a.date ?? "";
    console.log(`── appt ${id}  ${who}  ${when}`);
    const forms = a.forms;
    if (!Array.isArray(forms) || forms.length === 0) {
      console.log("   forms: none on this appointment");
    } else {
      console.log("   forms:");
      console.log(
        JSON.stringify(forms, null, 2)
          .split("\n")
          .map((l) => "   " + l)
          .join("\n"),
      );
    }
    console.log("");
  }

  console.log(
    "\nLOOK FOR: the form `name`, the values[].name of your consent question,\n" +
      "and values[].value for a CHECKED vs UNCHECKED box (e.g. 'yes'/'', 'Checked'/null).\n" +
      "That pins the matcher + checked-value for apps/api/src/acuity/consent.ts.",
  );
}

main().finally(() => prisma.$disconnect());
