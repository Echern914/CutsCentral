"use client";

import { useRef, useState, type DragEvent } from "react";
import { cn } from "@/lib/cn";
import { useImageUpload, type UploadKind } from "./useImageUpload";

/**
 * Single-image picker for the logo / hero. Upload from the device (click or
 * drag-drop) or paste a URL. Shows a live thumbnail with a clear button. `aspect`
 * shapes the preview to match where the image lands on the public page.
 */
export function ImageField({
  label,
  hint,
  value,
  onChange,
  kind,
  aspect = "video",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (url: string) => void;
  kind: UploadKind;
  aspect?: "square" | "video";
}) {
  const { uploading, error, upload, clearError, accept } = useImageUpload(kind);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const [editingUrl, setEditingUrl] = useState(false);

  async function handleFile(file: File) {
    clearError();
    const url = await upload(file);
    if (url) onChange(url);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDropActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  }

  const aspectCls = aspect === "square" ? "aspect-square w-28" : "aspect-[16/7] w-full";

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>

      {value ? (
        <div className={cn("group relative overflow-hidden rounded-xl border border-subtle bg-charcoal-700", aspectCls)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt={label} className="h-full w-full object-cover" />
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="rounded-full bg-white/90 px-3 py-1.5 text-xs font-medium text-charcoal transition-colors duration-150 ease-out hover:bg-white"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => onChange("")}
              className="rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 ease-out hover:bg-black/80"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={onDrop}
          disabled={uploading}
          className={cn(
            "flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-muted transition-colors duration-150 ease-out hover:border-gold/50 hover:text-gold disabled:opacity-60",
            aspectCls,
            dropActive ? "border-gold/60 bg-gold/5" : "border-subtle",
          )}
        >
          {uploading ? (
            <span className="text-xs">Uploading…</span>
          ) : (
            <>
              <span className="text-xl leading-none">＋</span>
              <span className="text-[11px]">Upload or drag</span>
            </>
          )}
        </button>
      )}

      <input
        ref={fileInput}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />

      {/* Paste-URL affordance (and the only path when uploads aren't configured). */}
      {editingUrl ? (
        <input
          autoFocus
          defaultValue={value}
          onBlur={(e) => {
            onChange(e.target.value.trim());
            setEditingUrl(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onChange((e.target as HTMLInputElement).value.trim());
              setEditingUrl(false);
            }
            if (e.key === "Escape") setEditingUrl(false);
          }}
          placeholder="https://…/image.jpg"
          className="rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted focus:border-gold/50 focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditingUrl(true)}
          className="self-start text-[11px] text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-offwhite hover:underline"
        >
          {value ? "Edit URL" : "or paste a URL"}
        </button>
      )}

      {hint && !error && <span className="text-[11px] text-muted/80">{hint}</span>}
      {error && <span className="text-[11px] text-danger-soft">{error}</span>}
    </div>
  );
}
