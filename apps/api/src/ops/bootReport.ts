import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { buildPreflight, type PreflightCapabilities } from "./preflight.js";
import { fetchWebConfig } from "./webConfig.js";

/**
 * Name every dark integration once, at boot, in the deploy log.
 *
 * 🔴 WHY A LOG LINE AND NOT ONLY THE ADMIN ROUTE. `GET /preflight` has existed
 * and been correct for months, and four integrations still sat off the whole
 * time - because a page only helps someone who already suspects something is
 * wrong, and nobody suspected. Analytics that silently records nothing looks
 * exactly like a product nobody used.
 *
 * A deploy log line is the one place an operator reliably looks at the exact
 * moment configuration could have changed. It costs nothing, it repeats every
 * deploy, and it names the gap instead of waiting to be asked.
 *
 * Deliberately NOT an alert. This is a steady state, not an incident: paging
 * hourly because Meta Pixel is unset trains people to ignore the channel that
 * should wake them for a failed payout.
 *
 * Never throws and never delays the listen callback - it is fire-and-forget.
 */
export function logIntegrationStatusAtBoot(caps: PreflightCapabilities): void {
  // Dev has almost everything off by design; the signal only means something
  // where the deployment is supposed to be complete.
  if (apiEnv().NODE_ENV !== "production") return;

  void (async () => {
    try {
      const web = await fetchWebConfig();
      const report = buildPreflight(
        apiEnv(),
        caps,
        Boolean(process.env.WEB_PROXY_SECRET),
        web,
      );
      const dark = report.checks.filter((c) => !c.ok);
      if (dark.length === 0) {
        logger.info(
          { blockers: 0, warnings: 0 },
          "ops: every integration configured",
        );
        return;
      }
      logger.warn(
        {
          blockers: report.blockers,
          warnings: report.warnings,
          // Keys only. The detail lines are in the admin report; this is a
          // pointer, and it must never carry a value that could be a secret.
          dark: dark.map((c) => c.key),
        },
        `ops: ${dark.length} integration(s) NOT configured - see GET /preflight`,
      );
    } catch (err) {
      // A status probe must never be the reason a deploy looks unhealthy.
      logger.warn({ err }, "ops: boot integration report failed");
    }
  })();
}
