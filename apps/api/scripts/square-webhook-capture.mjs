import { createServer } from "node:http";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = 8788;
const DIR = fileURLToPath(new URL("./captures/", import.meta.url));
mkdirSync(DIR, { recursive: true });

// Set once the subscription exists; lets us verify the signature recipe for real.
const SIG_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? "";
const NOTIFICATION_URL = process.env.SQUARE_NOTIFICATION_URL ?? "";

let n = 0;
const seen = new Map(); // event_id -> count, to prove stability across retries

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    n += 1;
    const sig = req.headers["x-square-hmacsha256-signature"] ?? null;

    let verdict = "no-key";
    if (SIG_KEY && NOTIFICATION_URL && typeof sig === "string") {
      const expected = createHmac("sha256", SIG_KEY)
        .update(NOTIFICATION_URL + raw.toString("utf8"))
        .digest("base64");
      const a = Buffer.from(expected);
      const b = Buffer.from(sig);
      verdict = a.length === b.length && timingSafeEqual(a, b) ? "VALID" : "MISMATCH";
    }

    let parsed = null;
    try { parsed = JSON.parse(raw.toString("utf8")); } catch {}
    const eventId = parsed?.event_id ?? "(none)";
    const type = parsed?.type ?? "(none)";
    seen.set(eventId, (seen.get(eventId) ?? 0) + 1);

    const record = {
      seq: n,
      receivedAt: new Date().toISOString(),
      type,
      event_id: eventId,
      deliveryCountForThisEventId: seen.get(eventId),
      signatureVerdict: verdict,
      headers: req.headers,
      body: parsed,
    };
    writeFileSync(`${DIR}/${String(n).padStart(2, "0")}-${type}.json`, JSON.stringify(record, null, 2));
    appendFileSync(`${DIR}/log.txt`,
      `#${n} ${type} event_id=${eventId} delivery#${seen.get(eventId)} sig=${verdict}\n`);
    console.log(`#${n} ${type} event_id=${eventId} delivery#${seen.get(eventId)} sig=${verdict}`);

    // Force a failure so Square retries, to test whether event_id is STABLE
    // across redeliveries (it is the inbox's idempotency key, so if Square
    // minted a new one per attempt the whole ledger would be worthless).
    const FAIL_FIRST = Number(process.env.FAIL_FIRST ?? 0);
    if (seen.get(eventId) <= FAIL_FIRST) {
      console.log(`   -> forced 500 (attempt ${seen.get(eventId)} of event ${eventId})`);
      appendFileSync(`${DIR}/log.txt`, `   -> forced 500
`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"forced":true}');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
}).listen(PORT, () => console.log(`capture server on :${PORT} -> ${DIR}`));
