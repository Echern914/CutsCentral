"use client";

import { useRef, useState, type DragEvent } from "react";
import { GALLERY_CAPTION_MAX, GALLERY_MAX, type GalleryItem } from "@chairback/config/constants";
import { cn } from "@/lib/cn";
import { useImageUpload } from "./useImageUpload";

/**
 * First-class gallery editor: upload photos from the device (drag-drop or pick),
 * OR paste an image URL - both land in the same grid. Each photo gets an optional
 * caption, can be deleted, and can be drag-reordered. Caps at GALLERY_MAX.
 *
 * No drag-and-drop library: HTML5 drag events for reorder, a hidden file input
 * for picking. Everything is local state; the parent persists on Save.
 *
 * Each photo can also say which service it shows and who did it. That is what
 * lets the page designs offer "Book this look" with both already picked, list
 * a service's photos with it, and filter the work by person.
 */
export function GalleryEditor({
  items,
  onChange,
  services = [],
  staff = [],
}: {
  items: GalleryItem[];
  onChange: (next: GalleryItem[]) => void;
  /** The shop's active services - hidden ones included, labeled as such. */
  services?: { id: string; name: string; visibility?: string }[];
  /** The shop's active team. The "who" choice shows only with two or more. */
  staff?: { id: string; name: string }[];
}) {
  const { uploading, error, upload, clearError, accept } = useImageUpload("gallery");
  const fileInput = useRef<HTMLInputElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  // How many of the last batch didn't upload. The hook's own error is cleared
  // by the NEXT upload starting, so the third of five failing used to leave no
  // trace once the fourth succeeded.
  const [failedCount, setFailedCount] = useState(0);
  // The list as of the latest render. A multi-photo upload takes seconds, and
  // appending to the `items` it STARTED with threw away every caption and tag
  // typed while it ran.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const remaining = GALLERY_MAX - items.length;

  function addUrls(urls: string[]) {
    const room = GALLERY_MAX - items.length;
    const next = urls.slice(0, Math.max(0, room)).map((url) => ({ url }));
    if (next.length) onChange([...items, ...next]);
  }

  async function handleFiles(files: FileList | File[]) {
    clearError();
    setFailedCount(0);
    const list = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, remaining);
    // Upload sequentially so order is predictable and we stop at the cap.
    const uploaded: GalleryItem[] = [];
    let failed = 0;
    for (const f of list) {
      const url = await upload(f);
      if (url) uploaded.push({ url });
      else failed++;
    }
    if (uploaded.length) {
      const latest = itemsRef.current;
      onChange([...latest, ...uploaded.slice(0, Math.max(0, GALLERY_MAX - latest.length))]);
    }
    if (list.length > 1) setFailedCount(failed);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDropActive(false);
    if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
  }

  function setCaption(i: number, caption: string) {
    const next = items.map((it, idx) => (idx === i ? { ...it, caption } : it));
    onChange(next);
  }

  function setTag(i: number, key: "serviceId" | "staffId", value: string) {
    onChange(
      items.map((it, idx) => {
        if (idx !== i) return it;
        const next: GalleryItem = { ...it };
        delete next[key];
        return value ? { ...next, [key]: value } : next;
      }),
    );
  }
  const tagsService = services.length > 0;
  const tagsStaff = staff.length > 1;
  const tagSelect =
    "w-full min-w-0 truncate rounded-lg border border-subtle bg-charcoal-800 px-1.5 py-1 text-[11px] text-offwhite focus:border-gold/50";

  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }

  // --- reorder (native drag) ---
  function onCardDragStart(i: number) {
    setDragIndex(i);
  }
  function onCardDragOver(e: DragEvent, i: number) {
    if (dragIndex === null) return; // only when reordering a card (not a file drag)
    e.preventDefault();
    setOverIndex(i);
  }
  function onCardDrop(i: number) {
    if (dragIndex === null || dragIndex === i) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }
    const next = [...items];
    const [moved] = next.splice(dragIndex, 1);
    if (moved) next.splice(i, 0, moved);
    onChange(next);
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          if (dragIndex !== null) return; // a card reorder is in progress
          e.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={onDrop}
        className={cn(
          "grid grid-cols-2 gap-3 rounded-2xl border border-dashed p-3 transition-colors duration-150 ease-out sm:grid-cols-3",
          dropActive ? "border-gold/60 bg-gold/5" : "border-subtle",
        )}
      >
        {items.map((item, i) => (
          <figure
            key={`${item.url}-${i}`}
            draggable
            onDragStart={() => onCardDragStart(i)}
            onDragOver={(e) => onCardDragOver(e, i)}
            onDrop={() => onCardDrop(i)}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            className={cn(
              "group relative cursor-grab overflow-hidden rounded-xl border bg-charcoal-700 transition-[border-color,box-shadow,opacity] duration-150 ease-out active:cursor-grabbing",
              overIndex === i && dragIndex !== null ? "border-gold/70 ring-2 ring-gold/40" : "border-subtle",
              dragIndex === i && "opacity-50",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={item.url} alt={item.caption || `Photo ${i + 1}`} className="aspect-square w-full object-cover" />
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label="Remove photo"
              className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white opacity-100 backdrop-blur transition-[opacity,background-color] duration-150 ease-out hover:bg-black/80 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
            >
              ✕
            </button>
            <figcaption className="bg-charcoal-700">
              <input
                value={item.caption ?? ""}
                onChange={(e) => setCaption(i, e.target.value.slice(0, GALLERY_CAPTION_MAX))}
                placeholder="Add a caption"
                maxLength={GALLERY_CAPTION_MAX}
                aria-label={`Caption for photo ${i + 1}`}
                className="w-full bg-transparent px-2.5 py-2 text-xs text-offwhite placeholder:text-muted/70 focus:outline-none"
              />
              {(tagsService || tagsStaff) && (
                <div className="flex gap-1 border-t border-subtle px-1.5 py-1.5">
                  {tagsService && (
                    <select
                      value={item.serviceId ?? ""}
                      onChange={(e) => setTag(i, "serviceId", e.target.value)}
                      aria-label={`Service in photo ${i + 1}`}
                      className={tagSelect}
                    >
                      <option value="">No service</option>
                      {services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.visibility === "hidden" ? `${s.name} (hidden)` : s.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {tagsStaff && (
                    <select
                      value={item.staffId ?? ""}
                      onChange={(e) => setTag(i, "staffId", e.target.value)}
                      aria-label={`Who did photo ${i + 1}`}
                      className={tagSelect}
                    >
                      <option value="">Anyone</option>
                      {staff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </figcaption>
          </figure>
        ))}

        {/* Add tile */}
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border border-subtle text-muted transition-colors duration-150 ease-out hover:border-gold/50 hover:text-gold disabled:opacity-60"
          >
            {uploading ? (
              <span className="text-xs">Uploading…</span>
            ) : (
              <>
                <span className="text-2xl leading-none">＋</span>
                <span className="text-[11px]">Add photo</span>
              </>
            )}
          </button>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={accept}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void handleFiles(e.target.files);
          e.target.value = ""; // allow re-picking the same file
        }}
      />

      {/* Paste-a-URL fallback (also works when uploads aren't configured). */}
      <div className="flex items-center gap-2">
        <input
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (urlDraft.trim()) {
                addUrls([urlDraft.trim()]);
                setUrlDraft("");
              }
            }
          }}
          placeholder="…or paste an image URL and press Enter"
          className="min-w-0 flex-1 rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted focus:border-gold/50 focus:outline-none"
        />
        <button
          type="button"
          disabled={!urlDraft.trim() || remaining <= 0}
          onClick={() => {
            addUrls([urlDraft.trim()]);
            setUrlDraft("");
          }}
          className="shrink-0 rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
        >
          Add
        </button>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>
          {items.length}/{GALLERY_MAX} photos · drag to reorder
        </span>
        {failedCount > 0 ? (
          <span role="alert" className="text-danger-soft">
            {failedCount === 1 ? "1 photo" : `${failedCount} photos`} didn&rsquo;t upload. Try
            {failedCount === 1 ? " it" : " them"} again.
          </span>
        ) : (
          error && <span className="text-danger-soft">{error}</span>
        )}
      </div>
    </div>
  );
}
