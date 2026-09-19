/**
 * The SDK wants connection tokens; only the page can fetch them.
 *
 * `StripeTerminalProvider` takes a `tokenProvider: () => Promise<string>` and
 * calls it whenever it needs a fresh token - at connect, and again on its own
 * schedule afterwards. The shell cannot answer: /terminal/connection-token
 * wants the barber's session, which lives in the WebView's cookie jar and not
 * in the native app. So each request is relayed to the page, which fetches and
 * posts the answer back.
 *
 * 🔴 EVERY REQUEST MUST SETTLE. A tokenProvider promise that never resolves
 * hangs the SDK with no error and no timeout, which on a checkout screen means
 * a barber holding a phone out at a customer while nothing happens and nothing
 * says why. A page that fails to fetch replies with `null`, an unanswered
 * request times out, and both reject - so the collection fails visibly instead
 * of hanging.
 */

const TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (secret: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TokenRelay {
  private pending = new Map<string, Pending>();
  private n = 0;

  constructor(
    /** Injects the "please fetch a token" script into the page. */
    private readonly ask: (nonce: string) => void,
    private readonly timeoutMs: number = TIMEOUT_MS,
  ) {}

  /** What `StripeTerminalProvider` is handed as its tokenProvider. */
  request = (): Promise<string> => {
    const nonce = `tok_${++this.n}_${Date.now().toString(36)}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(new Error("connection token timed out"));
      }, this.timeoutMs);
      this.pending.set(nonce, { resolve, reject, timer });
      try {
        this.ask(nonce);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(nonce);
        reject(err instanceof Error ? err : new Error("could not ask the page for a token"));
      }
    });
  };

  /** The page answered. A null secret means it could not get one. */
  settle(nonce: string, secret: string | null): void {
    const p = this.pending.get(nonce);
    // An unknown nonce is a late or duplicated reply; dropping it is correct.
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(nonce);
    if (secret) p.resolve(secret);
    else p.reject(new Error("the page could not fetch a connection token"));
  }

  /** Fail everything outstanding - the screen went away mid-request. */
  dispose(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("tap to pay was dismissed"));
    }
    this.pending.clear();
  }
}
