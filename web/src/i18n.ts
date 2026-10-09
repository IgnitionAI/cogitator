import { useSyncExternalStore } from "react";
import { commonMessages } from "./locales/common";
import { screensMessages } from "./locales/screens";
import { workspaceMessages } from "./locales/workspace";
import { chatMessages } from "./locales/chat";
import { diagnosticMessages } from "./locales/diagnostics";

export type Locale = "en" | "fr";
export const LOCALE_STORAGE_KEY = "cogitator.locale";
export const messages = { ...commonMessages, ...screensMessages, ...workspaceMessages, ...chatMessages, ...diagnosticMessages };
export type TranslationKey = keyof typeof messages;
type Values = Record<string, string | number>;

export function resolveLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === "en" || saved === "fr") return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "en" || base === "fr") return base;
  }
  return "en";
}

function initialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  let saved: string | null = null;
  try { saved = window.localStorage.getItem(LOCALE_STORAGE_KEY); }
  catch { /* Private browsing can disable storage; language still works in memory. */ }
  return resolveLocale(saved, globalThis.navigator?.languages ?? []);
}

let locale = initialLocale();
const listeners = new Set<() => void>();
export const getLocale = (): Locale => locale;

function applyLocale(next: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (locale === next) return;
  locale = next;
  listeners.forEach((listener) => listener());
}

export function setLocale(next: Locale): void {
  if (next !== "en" && next !== "fr") return;
  try { if (typeof window !== "undefined") window.localStorage.setItem(LOCALE_STORAGE_KEY, next); }
  catch { /* Preference persistence is best-effort, not required to switch. */ }
  applyLocale(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Subscribe at the app and toast roots: language updates never remount a form. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

if (typeof window !== "undefined") {
  applyLocale(locale);
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCALE_STORAGE_KEY && event.key !== null) return;
    applyLocale(resolveLocale(event.newValue, navigator.languages));
  });
}

export function interpolate(template: string, values: Values = {}): string {
  return template.replace(/\{(\w+)\}/g, (token, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : token);
}

export function t(key: TranslationKey, values?: Values): string {
  return interpolate(messages[key][locale], values);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" }): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatTime(value: string | number | Date, options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" }): string {
  return formatDate(value, options);
}

export function statusLabel(status: string): string {
  const key = `status.${status}`;
  return Object.hasOwn(commonMessages, key) ? t(key as keyof typeof commonMessages) : t("status.unknown", { status });
}

export function thinkingLabel(thinking: string): string {
  const key = `thinking.${thinking}`;
  return Object.hasOwn(commonMessages, key) ? t(key as keyof typeof commonMessages) : thinking;
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Existing APIs and persisted errors contain prose rather than message IDs. Match
// only catalogued UI/diagnostic templates; never run this over user content.
const textMatchers = Object.values(messages).flatMap((entry) => (["fr", "en"] as const).map((source) => {
  const template = entry[source];
  const keys: string[] = [];
  let offset = 0;
  let pattern = "^";
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    pattern += escapeRegex(template.slice(offset, match.index)) + "([\\s\\S]*?)";
    keys.push(match[1]!);
    offset = match.index! + match[0].length;
  }
  pattern += escapeRegex(template.slice(offset)) + "$";
  return { entry, keys, pattern: new RegExp(pattern), specificity: template.replace(/\{\w+\}/g, "").length };
})).sort((a, b) => b.specificity - a.specificity);

/** Re-localize stored toasts/errors on language changes, preserving raw details. */
export function localizeText(text: string, depth = 0): string {
  if (depth > 4) return text;
  const errorPrefix = /^(?:Error|Erreur): /.exec(text);
  if (errorPrefix) return `${t("common.error")}: ${localizeText(text.slice(errorPrefix[0].length), depth + 1)}`;
  for (const matcher of textMatchers) {
    const match = matcher.pattern.exec(text);
    if (!match) continue;
    const values = Object.fromEntries(matcher.keys.map((key, index) => {
      const value = match[index + 1]!;
      return [key, /^(error|detail|reason|message|status)$/.test(key) ? localizeText(value, depth + 1) : value];
    }));
    return interpolate(matcher.entry[locale], values);
  }
  const lines = text.split("\n");
  if (lines.length > 1 && textMatchers.some(({ pattern }) => pattern.test(lines[0]!))) {
    return lines.map((line) => localizeText(line, depth + 1)).join("\n");
  }
  const issue = /^([a-z_][\w-]*(?:\.[\w-]+)*): (.+)$/.exec(text);
  if (issue) return `${issue[1]}: ${localizeText(issue[2]!, depth + 1)}`;
  return text;
}
