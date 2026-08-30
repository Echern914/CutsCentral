"use client";

import { createContext, useContext, type ReactNode } from "react";
import { NEUTRAL_VOCABULARY, type BusinessVocabulary } from "@chairback/config/businessTypes";

/**
 * Carries the shop's vocabulary to CLIENT components.
 *
 * WHY A CONTEXT HERE, WHEN SERVER COMPONENTS PASS IT AS A PROP. The dashboard's
 * big client trees keep their copy in components nested several levels inside a
 * single file - `BookingManager.tsx` alone is ~4,000 lines with the strings that
 * need vocabulary sitting in child components. Prop-drilling into those means
 * touching every intermediate signature to deliver one value that never changes
 * during a render, and a missed link is a compile error in a file nobody wanted
 * to reformat.
 *
 * 🔴 This is TRANSPORT, not a second source of truth. The value is resolved once
 * on the SERVER (`getVocabulary()` -> `/api/auth/me` -> `vocabularyForShop`) and
 * handed in at the dashboard layout. Nothing here derives, caches or defaults to
 * a shop's words - the only fallback is NEUTRAL, and that fallback exists so a
 * component rendered outside the provider (a test, a stray subtree) still shows
 * complete words rather than blanks or barbershop terms it never chose.
 */
const VocabContext = createContext<BusinessVocabulary>(NEUTRAL_VOCABULARY);

export function VocabProvider({
  value,
  children,
}: {
  value: BusinessVocabulary;
  // `ReactNode` imported from "react" rather than the `React.` namespace: this
  // repo resolves @types/react from two places, and the namespace form makes the
  // two copies' ReactNode mutually unassignable.
  children: ReactNode;
}) {
  return <VocabContext.Provider value={value}>{children}</VocabContext.Provider>;
}

/**
 * The active shop's words, inside a client component.
 *
 * Never throws when used outside the provider: a missing provider degrades to
 * neutral copy, which is wrong-but-harmless, where a thrown error would take a
 * working page down over wording.
 */
export function useVocab(): BusinessVocabulary {
  return useContext(VocabContext);
}

/** Sentence-case a vocabulary word ("chair" -> "Chair") for the start of a label. */
export function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
