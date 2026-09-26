import { instagramUrl } from "@chairback/config/clientIdentity";

/**
 * A client's Instagram handle, linked to their profile. Shown next to a name
 * wherever the name alone may not say which Mike this is. The handle is stored
 * bare and already validated (config clientIdentity.ts), so it is safe to put
 * in a URL as-is; renders nothing when there is none.
 */
export function InstagramHandle({ handle, className }: { handle: string | null | undefined; className?: string }) {
  if (!handle) return null;
  return (
    <a
      href={instagramUrl(handle)}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? "text-gold underline-offset-2 hover:underline"}
    >
      @{handle}
    </a>
  );
}
