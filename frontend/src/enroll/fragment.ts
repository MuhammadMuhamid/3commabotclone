/**
 * OD-4: the FIRST thing the enrollment page does — imported before anything
 * else in `main.tsx`, so it runs before React or any other module.
 *
 * The Platform sends the browser to `/enroll#t=<ticket>`. The fragment is
 * never sent to a server or in a Referer, but it stays in the address bar
 * and in history. It is read once into memory here and removed from the URL
 * immediately, before any request is made.
 */
const TICKET_RE = /^#t=([A-Za-z0-9_-]{43})$/;

function takeTicket(): string | null {
  if (typeof location === "undefined") return null;
  const raw = location.hash;
  if (raw) history.replaceState(null, "", location.pathname);
  const match = TICKET_RE.exec(raw);
  return match ? match[1]! : null;
}

/** The ticket from the fragment, or null (no fragment, a reload, or a malformed one). */
export const ticketFromFragment: string | null = takeTicket();
