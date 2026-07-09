import "../src/env-bootstrap.js";
import fs from "node:fs";
import readline from "node:readline";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setMessageProviderForTests } from "../src/messaging/twilio.js";
import type { MessageProvider } from "../src/messaging/provider.js";
import { processInboundText } from "../src/receptionist/inbound.js";
import { receptionistSkipReason } from "../src/receptionist/config.js";
import { resolvePromptPath } from "../src/receptionist/prompt.js";

/**
 * Full local simulation of the AI receptionist: fake inbound text -> the REAL
 * pipeline (shop routing, prompt file, Anthropic API, tools against the REAL
 * slot engine/DB) -> captured outbound SMS + the tool-call audit trail. Nothing
 * ever reaches a phone: the message provider is replaced with a capture fake
 * before the first turn.
 *
 * Usage (repo root, .env loaded; needs ANTHROPIC_API_KEY):
 *   pnpm --filter @chairback/api exec tsx scripts/receptionist-sim.ts --shop <slug>
 *   ... --phone +15555550100        simulate a specific sender number
 *   ... --script turns.json         non-interactive: JSON array of inbound texts
 *
 * The shop must pass the same gate as production (receptionistEnabled + terms
 * accepted + native booking + entitlement) - the sim tells you which gate fails.
 */

const PROD_REF = "czqjnhwxcubnskyfamvb"; // prod Supabase project - never simulate against it

interface CapturedSms {
  to: string;
  body: string;
}

const captured: CapturedSms[] = [];
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    captured.push(input);
    return { sid: `SIM${captured.length}`, status: "simulated" };
  },
};

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function printTurnResult(conversationId: string, sinceSms: number): Promise<void> {
  const last = await prisma.receptionistMessage.findFirst({
    where: { conversationId, role: "assistant" },
    orderBy: { createdAt: "desc" },
    select: { content: true, toolCalls: true },
  });
  const calls = (last?.toolCalls ?? []) as {
    name: string;
    input: unknown;
    result: string;
    isError: boolean;
  }[];
  for (const c of calls) {
    const status = c.isError ? "ERROR" : "ok";
    console.log(`  [tool ${status}] ${c.name}(${JSON.stringify(c.input)})`);
    console.log(`           -> ${c.result.slice(0, 300)}`);
  }
  const sent = captured.slice(sinceSms);
  if (sent.length === 0) {
    console.log("  (no SMS sent - escalated thread, opt-out, or silent path)");
  }
  for (const s of sent) {
    console.log(`  AI -> ${s.to}: ${s.body}`);
  }
}

async function main(): Promise<void> {
  const env = apiEnv();
  if (env.DATABASE_URL.includes(PROD_REF)) {
    console.error("Refusing to run the simulator against the PROD database.");
    process.exit(1);
  }
  if (!env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set - the simulator needs the real model.");
    process.exit(1);
  }
  if (!resolvePromptPath()) {
    console.error("ai/receptionist-prompt.md not found (or RECEPTIONIST_PROMPT_PATH wrong).");
    process.exit(1);
  }

  const shopKey = arg("--shop");
  if (!shopKey) {
    const shops = await prisma.shop.findMany({
      where: { bookingMode: "native" },
      select: { slug: true, name: true, receptionistEnabled: true },
      take: 20,
    });
    console.error("Usage: receptionist-sim.ts --shop <slug|id> [--phone +1...] [--script turns.json]");
    console.error("Native-mode shops in this DB:");
    for (const s of shops) {
      console.error(
        `  ${s.slug ?? "(no slug)"}  ${s.name}  receptionistEnabled=${s.receptionistEnabled}`,
      );
    }
    process.exit(1);
  }

  const shop = await prisma.shop.findFirst({
    where: { OR: [{ slug: shopKey }, { id: shopKey }] },
  });
  if (!shop) {
    console.error(`No shop matching "${shopKey}".`);
    process.exit(1);
  }

  const gate = receptionistSkipReason(shop);
  if (gate) {
    console.error(`Shop "${shop.name}" fails the receptionist gate: ${gate}`);
    console.error(
      "For a local sim you can flip the flags directly, e.g.:\n" +
        `  UPDATE "Shop" SET "receptionistEnabled"=true, "receptionistCompAccess"=true,\n` +
        `    "receptionistTermsAcceptedAt"=now() WHERE id='${shop.id}';`,
    );
    process.exit(1);
  }

  const phone = arg("--phone") ?? "+15555550100";
  const client = await prisma.client.findFirst({
    where: { shopId: shop.id, phone, archivedAt: null },
    select: { id: true, firstName: true },
  });
  if (!client) {
    console.error(
      `No client with phone ${phone} at "${shop.name}" - the shared-number v1 ` +
        "routing only serves known clients. Create one (dashboard or SQL) or pass " +
        "--phone of an existing client.",
    );
    process.exit(1);
  }

  __setMessageProviderForTests(fakeProvider);
  console.log(`Simulating ${phone} (${client.firstName ?? "client"}) -> "${shop.name}"`);
  console.log("Type an inbound text; 'exit' quits. Tool calls + replies print per turn.\n");

  const runTurn = async (text: string): Promise<void> => {
    const before = captured.length;
    console.log(`\nCLIENT -> shop: ${text}`);
    await processInboundText({ phone, text });
    const convo = await prisma.receptionistConversation.findFirst({
      where: { shopId: shop.id, phone },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, status: true },
    });
    if (!convo) {
      console.log("  (no conversation created - routing declined this number)");
      return;
    }
    await printTurnResult(convo.id, before);
    if (convo.status !== "active") console.log(`  [thread status: ${convo.status}]`);
  };

  const scriptPath = arg("--script");
  if (scriptPath) {
    const turns = JSON.parse(fs.readFileSync(scriptPath, "utf8")) as string[];
    for (const t of turns) await runTurn(t);
    await prisma.$disconnect();
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): void => {
    rl.question("> ", (line) => {
      const text = line.trim();
      if (!text || text.toLowerCase() === "exit") {
        rl.close();
        void prisma.$disconnect().then(() => process.exit(0));
        return;
      }
      void runTurn(text).finally(ask);
    });
  };
  ask();
}

void main();
