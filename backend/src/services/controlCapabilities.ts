/**
 * B-CAP: what this Bot's control channel can do, advertised in C0 as
 * `capabilities: string[]`.
 *
 * The Platform shows a feature only when the capability is listed here, so a
 * new Platform never offers an action an older (or differently configured)
 * Bot would refuse. Absence means "old peer": hide or disable with an
 * explanation. Each entry names a versioned contract; a capability is listed
 * only while its routes are mounted AND enabled.
 *
 * Kept as one small builder in its own module so every slice adds its own
 * entry here (bot-exec adds `entries.v1`, `operatorExit.v1`,
 * `manualPositionFull.v1`).
 */
import { config } from "../config.js";

export function buildControlCapabilities(): string[] {
  const capabilities = [
    "bots.v1",     // C10–C14: create, read, edit, delete, rotate-secret
    "accounts.v1", // C15, C16, C19: list, delete, balance
    "entries.v1",  // C9: pause / resume new entries (OD-3)
    "manualPositionFull.v1", // manual SELL `positionFull` (OD-7)
    "operatorExit.v1", // C6/C7 trade-id-targeted operator exits
    "tradeArchive.v1", // POST /control/trades/:id/archive (Feature B; presentation state only)
  ];
  // C17/C18 + /enroll: only while ENROLLMENT_ENABLED (the public routes 404 otherwise).
  if (config.enrollmentEnabled) capabilities.push("enroll.v1");
  return capabilities;
}
