import { THEME_COOKIE } from "@orch/protocol";

/*
 * Per-browser theme override. The server reads the cookie when serving `/theme.css`, so the theme is a
 * render-blocking stylesheet from the first paint (no flash); see README "Themes".
 */
const ONE_YEAR_S = 365 * 24 * 60 * 60;

/** The cookie's theme name, or null when the browser follows the server default. */
export function currentTheme(): string | null {
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === THEME_COOKIE) return decodeURIComponent(part.slice(eq + 1)) || null;
  }
  return null;
}

/** Stores the choice (null = server default) and swaps the stylesheet in place, without a reload. */
export function setTheme(name: string | null): void {
  document.cookie =
    name === null
      ? `${THEME_COOKIE}=; path=/; max-age=0; SameSite=Lax`
      : `${THEME_COOKIE}=${encodeURIComponent(name)}; path=/; max-age=${ONE_YEAR_S}; SameSite=Lax`;
  const link = document.getElementById("theme");
  // A new URL so the browser re-requests instead of reusing the stylesheet it already applied.
  if (link instanceof HTMLLinkElement) link.href = `/theme.css?v=${encodeURIComponent(name ?? "")}`;
}
