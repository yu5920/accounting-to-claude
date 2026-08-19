// Guarded HTTP client for the AutoCount Cloud Accounting Integration API.
//
//   https://accounting-api.autocountcloud.com
//
// This file is the whole security boundary on the client side. The direct
// database path (index.js) is read-only *by construction* - its guard rejects
// anything that is not a single SELECT, so a write is not expressible. A REST
// API has no such property: the same base URL serves POST /invoice/void and
// DELETE /journalentry. The only real boundary is the permission set on the
// API key, which is configured in the Cloud Accounting web app and defaults to
// ALL PERMISSIONS.
//
// So there are two layers, and neither is sufficient alone:
//
//   1. Server side - the API key must be created with the write methods
//      switched off. That is the boundary that actually holds.
//   2. This file - an allowlist of (method, path) pairs. Every request is
//      checked against it. Nothing that mutates appears in the list, and
//      request() refuses anything not on it.
//
// Note that "GET only" is NOT the rule, and cannot be: account/listing and
// product/listing are POST-only endpoints that read. They take a filter object
// in the body because the filter is too big for a query string. They create
// nothing. That is why the allowlist is (method, path) pairs rather than a
// method check - a method check would either block the chart of accounts or
// let every void through.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- credentials

// .env sits next to this file and is excluded by .gitignore. Real environment
// variables win, so a scheduled job can supply them without a file on disk.
function loadEnvFile() {
  const p = resolve(HERE, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;                       // comments and blanks
    if (process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadEnvFile();

export const BASE_URL =
  (process.env.ACCT_CLOUD_BASE || "https://accounting-api.autocountcloud.com")
    .replace(/\/+$/, "");

const KEY_ID  = process.env.ACCT_CLOUD_KEY_ID  || "";
const API_KEY = process.env.ACCT_CLOUD_API_KEY || "";

export const BOOKS = (process.env.ACCT_CLOUD_BOOKS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const TIMEOUT_MS = (Number(process.env.ACCT_TIMEOUT) || 60) * 1000;

export function credentialsPresent() {
  return Boolean(KEY_ID && API_KEY);
}

// Never let a key reach a log, an error message or a dashboard file. Anything
// that might be echoed goes through this first.
export function redact(text) {
  let out = String(text ?? "");
  for (const secret of [API_KEY, KEY_ID]) {
    if (secret && secret.length >= 6) out = out.split(secret).join("<redacted>");
  }
  return out;
}

// ------------------------------------------------------------------ allowlist

// Every read this client is permitted to make. Path templates are matched
// literally after {accountBookId} is substituted, so a crafted book id cannot
// walk into another route.
//
// Deliberately absent, and never to be added here: /void, DELETE, PUT, and the
// POST create forms of the document endpoints. If a future feature seems to
// need one, it does not - this tool reports, it does not post.
export const READS = [
  ["GET",  "/{book}/companyprofile"],
  ["POST", "/{book}/account/listing"],            // POST, but a read - see header
  ["GET",  "/{book}/department/listing"],
  ["GET",  "/{book}/area/listing"],
  ["GET",  "/{book}/salesagent/listing"],
  ["GET",  "/{book}/location/listing"],
  ["GET",  "/{book}/paymentmethod/listing"],
  ["GET",  "/{book}/taxentity/listing"],
  ["GET",  "/{book}/debtor/listing"],
  ["GET",  "/{book}/debtor"],
  ["GET",  "/{book}/creditor/listing"],
  ["GET",  "/{book}/creditor"],
  ["GET",  "/{book}/journalentry/listing"],
  ["GET",  "/{book}/journalentry"],
  ["GET",  "/{book}/journalentry/knockoffdetails"],
  ["GET",  "/{book}/invoice/listing"],
  ["GET",  "/{book}/invoice"],
  ["GET",  "/{book}/invoice/knockoffdetails"],
  ["GET",  "/{book}/purchaseinvoice/listing"],
  ["GET",  "/{book}/purchaseinvoice"],
  ["GET",  "/{book}/purchaseinvoice/knockoffdetails"],
  ["GET",  "/{book}/creditnote/listing"],
  ["GET",  "/{book}/creditnote"],
  ["GET",  "/{book}/creditnote/knockoffdetails"],
  ["GET",  "/{book}/purchasereturn/listing"],
  ["GET",  "/{book}/purchasereturn"],
  ["GET",  "/{book}/payment/listing"],
  ["GET",  "/{book}/payment"],
  ["GET",  "/{book}/payment/knockoffdetails"],
  ["GET",  "/{book}/knockoffentry/listing"],
  ["GET",  "/{book}/knockoffentry"],
  ["GET",  "/{book}/knockoffentry/outstandingtransactions"],
];

const ALLOWED = new Set(READS.map(([m, p]) => m + " " + p));

export class GuardError extends Error {}
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ------------------------------------------------------------------- transport

/**
 * Perform one allowlisted read.
 *
 * @param method  "GET" or "POST" - and POST only for the listing endpoints
 *                that are reads. Checked against ALLOWED as a pair, so this
 *                argument alone can never widen access.
 * @param template  path with a literal "{book}" placeholder, exactly as it
 *                appears in READS.
 */
export async function request(method, template, { book, query, body } = {}) {
  const key = String(method).toUpperCase() + " " + template;
  if (!ALLOWED.has(key)) {
    throw new GuardError(
      "Refused: " + key + " is not an allowlisted read. This client cannot " +
      "issue writes; see READS in cloud-api.js."
    );
  }
  if (!book) throw new GuardError("No account book id given.");
  // A book id is an opaque token from the vendor. Refuse anything with path
  // syntax in it so it cannot be used to reach a route that is not on the list.
  if (/[/?#\\]/.test(book)) throw new GuardError("Invalid account book id.");
  // Credentials are checked last, so that every guard rejection above happens
  // for its own reason. Checking them first would make the guard self-test pass
  // on an unconfigured machine without exercising the guard at all.
  if (!credentialsPresent()) {
    throw new GuardError(
      "No credentials. Set ACCT_CLOUD_KEY_ID and ACCT_CLOUD_API_KEY in " +
      "assets/mcp-server/.env or in the environment."
    );
  }

  const url = new URL(BASE_URL + template.replace("{book}", encodeURIComponent(book)));
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }

  const headers = { "Key-ID": KEY_ID, "API-Key": API_KEY, Accept: "application/json" };
  const init = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});   // the API wants {} rather than empty
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError(redact("Network error calling " + template + ": " + e.message), 0, null);
  }

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw below */ }

  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? "  (check the API key is active and that this method is enabled in its permission list)"
      : "";
    throw new ApiError(
      redact(method + " " + template + " -> HTTP " + res.status + hint + "\n" +
             (text || "").slice(0, 500)),
      res.status, parsed
    );
  }

  // An empty result and a failed call are different things, and conflating them
  // is how a dashboard ends up quietly showing zero. Callers get a value here
  // only when the request genuinely succeeded; failures throw.
  return parsed;
}

// ---------------------------------------------------------------------- paging

/**
 * Walk a {data, totalCount} listing endpoint to the end.
 *
 * Pages are 1-based. Stops when the accumulated count reaches totalCount or a
 * page comes back empty, and refuses to loop forever - a listing that never
 * reports totalCount would otherwise spin.
 */
export async function pageAll(method, template, { book, query, body, max = 1000, onPage } = {}) {
  const rows = [];
  let total = null;
  for (let page = 1; page <= max; page++) {
    const q = { ...(query || {}), page };
    const b = method === "POST" ? { ...(body || {}), page } : body;
    const r = await request(method, template, { book, query: q, body: b });
    const batch = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []);
    if (r && typeof r.totalCount === "number") total = r.totalCount;
    rows.push(...batch);
    if (onPage) onPage(page, batch.length, total);
    if (!batch.length) break;
    if (total !== null && rows.length >= total) break;
    if (Array.isArray(r)) break;             // a bare array is not paged
    await new Promise((r2) => setTimeout(r2, PAGE_DELAY_MS));
  }
  return { rows, total };
}

// The vendor documents no rate limit, which is not the same as there being
// none. Space the pages out rather than discovering the limit on live books.
const PAGE_DELAY_MS = Number(process.env.ACCT_CLOUD_PAGE_DELAY_MS) || 250;

// ------------------------------------------------------------ field integrity

/**
 * The listing endpoints take a `field` array saying which columns to return,
 * and they DROP unrecognised names silently - no error, no warning, the column
 * simply is not there. A typo therefore produces a dashboard that is missing a
 * measure rather than a run that fails, which is the wrong way round.
 *
 * Call this on the first page of any listing where fields were requested.
 */
export function assertFields(rows, wanted, where) {
  if (!rows.length) return;
  const got = new Set(Object.keys(rows[0]));
  const missing = wanted.filter((f) => !got.has(f));
  if (missing.length) {
    throw new Error(
      where + ": requested field(s) not returned: " + missing.join(", ") +
      ". The API drops unknown field names silently - check spelling and case " +
      "against the view model. Returned: " + [...got].join(", ")
    );
  }
}
