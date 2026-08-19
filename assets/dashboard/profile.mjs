// Per-install settings, so the pipeline itself carries nothing customer-specific.
//
// Everything that differs between one company and the next lives in
// profile.json next to this file. The scripts read it through here and fall
// back to neutral defaults, so a fresh copy of the pipeline runs without any
// editing - it just produces an unbranded dashboard until the profile is filled.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = resolve(HERE, "profile.json");

const DEFAULTS = {
  brand: "",                 // company name in the page header
  system: "",                // autocount-cloud | autocount-desktop | sql-accounting | ...
  books: [],                 // [{ id, short, name, tier }]
  groupHints: [],            // name fragments that suggest a counterparty inside the group
  months: 37,                // how far back to pull
  refreshTime: "08:00",
};

let loaded = DEFAULTS;
if (existsSync(PATH)) {
  try {
    loaded = { ...DEFAULTS, ...JSON.parse(readFileSync(PATH, "utf8")) };
  } catch (e) {
    // A broken profile must not silently fall back to defaults - that would
    // quietly rebrand someone's dashboard and change which books are read.
    throw new Error("profile.json is not valid JSON: " + e.message);
  }
}

export const profile = loaded;
export const brand = process.env.BRAND || loaded.brand || "";
export const groupHints = (loaded.groupHints || []).map((s) => String(s).toUpperCase());
