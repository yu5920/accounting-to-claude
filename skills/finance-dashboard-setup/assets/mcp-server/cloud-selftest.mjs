// Self-test for the read-only AutoCount Cloud client.
//
//   node cloud-selftest.mjs
//
// Two groups, and they fail for different reasons.
//
// GUARD proves this client cannot be talked into writing. It needs no
// credentials and no network - the guard rejects before either is consulted.
// If any line reports ALLOWED, stop. Do not point this at live books.
//
// INTEGRITY proves the values that come back are the values in the books. It
// needs credentials, and is skipped without them rather than reported as
// passing. A skipped check is not a passed check and is not counted as one.
//
// What this file deliberately does NOT do: probe the API key's server-side
// permissions by attempting a write. Sending POST /invoice or DELETE
// /journalentry at a live book to see whether it is refused risks doing the
// exact thing being guarded against. Read the key's permission list in the
// Cloud Accounting web app instead - Settings > API Keys.
import {
  request, pageAll, READS, GuardError, ApiError,
  credentialsPresent, BOOKS, BASE_URL, redact,
} from "./cloud-api.js";

let failures = 0, skipped = 0;
const pass = (m, d) => console.log("PASS  " + m + (d ? "  -- " + d : ""));
const fail = (m, d) => { failures++; console.log("FAIL  " + m + (d ? "  -- " + d : "")); };
const skip = (m, d) => { skipped++;  console.log("SKIP  " + m + (d ? "  -- " + d : "")); };

// A guard check passes only when the call is refused by the GUARD, before any
// network traffic. An ApiError would mean the request was actually sent.
async function refuses(label, fn) {
  try {
    await fn();
    fail(label, "ALLOWED - the guard let this through");
  } catch (e) {
    if (e instanceof GuardError) pass(label, e.message.split("\n")[0].slice(0, 72));
    else if (e instanceof ApiError) fail(label, "reached the network: " + e.message.slice(0, 60));
    else fail(label, "unexpected " + e.constructor.name + ": " + e.message.slice(0, 60));
  }
}

console.log("Read-only guard self-test");
console.log("base: " + BASE_URL);
console.log("credentials: " + (credentialsPresent() ? "present" : "ABSENT (integrity half will skip)"));
console.log("books configured: " + (BOOKS.length || "none") + "\n");

// ------------------------------------------------------------------- guard
console.log("-- guard --");
const B = BOOKS[0] || "TESTBOOK";

await refuses("void an invoice",        () => request("POST",   "/{book}/invoice/void",   { book: B }));
await refuses("void a journal entry",   () => request("POST",   "/{book}/journalentry/void", { book: B }));
await refuses("delete a journal entry", () => request("DELETE", "/{book}/journalentry",   { book: B }));
await refuses("update an invoice",      () => request("PUT",    "/{book}/invoice",        { book: B }));
await refuses("create an invoice",      () => request("POST",   "/{book}/invoice",        { book: B }));
await refuses("path not on the list",   () => request("GET",    "/{book}/../admin",       { book: B }));
await refuses("book id with traversal", () => request("GET",    "/{book}/invoice/listing", { book: "a/../b" }));
await refuses("lowercase delete",       () => request("delete", "/{book}/invoice",        { book: B }));

// A static audit of the list itself, so a future edit that adds a write path
// fails here rather than in production.
{
  const bad = READS.filter(([m, p]) =>
    m !== "GET" && !(m === "POST" && p.endsWith("/listing")));
  if (bad.length) fail("allowlist contains a non-read", bad.map((x) => x.join(" ")).join(", "));
  else pass("allowlist contains only reads", READS.length + " entries");

  const danger = READS.filter(([, p]) => /void|delete|cancel|update|create/i.test(p));
  if (danger.length) fail("allowlist mentions a mutating route", danger.map((x) => x[1]).join(", "));
  else pass("no mutating route named in the allowlist");
}

// Credentials must never travel in a URL, only in headers.
{
  const leaky = READS.filter(([, p]) => /key|token|secret/i.test(p));
  if (leaky.length) fail("credential-shaped path parameter", leaky.join(", "));
  else pass("credentials are header-only");
}

// ---------------------------------------------------------------- integrity
console.log("\n-- integrity --");

if (!credentialsPresent() || !BOOKS.length) {
  const why = !credentialsPresent() ? "no credentials in .env" : "ACCT_CLOUD_BOOKS is empty";
  skip("all integrity checks", why);
} else {
  const book = BOOKS[0];

  // Does the connection work at all, and is this book reachable?
  let profile = null;
  try {
    profile = await request("GET", "/{book}/companyprofile", { book });
    pass("companyprofile", "book " + book + " reachable");
  } catch (e) {
    fail("companyprofile", redact(e.message).split("\n")[0].slice(0, 110));
  }

  if (profile) {
    // Non-ASCII round-trip. Malaysian books routinely hold Chinese company and
    // customer names; a transport that mangles them corrupts every label on the
    // dashboard without raising an error.
    const text = JSON.stringify(profile);
    const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 127);
    if (!nonAscii.length) skip("non-ASCII round-trip", "company profile is all ASCII; retested on debtor names below");
    else if (text.includes("�")) fail("non-ASCII round-trip", "replacement characters present - encoding is broken");
    else pass("non-ASCII round-trip", nonAscii.length + " non-ASCII chars intact");

    // An empty result and a failed call must be distinguishable.
    try {
      const r = await request("GET", "/{book}/invoice", { book, query: { docNo: "__NO_SUCH_DOC__" } });
      pass("missing document is not an error", "returned " + (r === null ? "null" : typeof r));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404)
        pass("missing document is not an error", "404, distinguishable from a transport failure");
      else fail("missing document", redact(e.message).slice(0, 90));
    }

    // Paging must not lose or duplicate rows.
    try {
      const { rows, total } = await pageAll("GET", "/{book}/debtor/listing", { book, max: 20 });
      const codes = rows.map((r) => r.AccNo ?? r.debtorCode ?? JSON.stringify(r));
      const unique = new Set(codes).size;
      if (total !== null && rows.length !== total)
        fail("paging is complete", "collected " + rows.length + " of totalCount " + total);
      else pass("paging is complete", rows.length + " rows" + (total === null ? " (no totalCount)" : ""));
      if (unique !== rows.length) fail("paging does not duplicate", (rows.length - unique) + " repeats across pages");
      else pass("paging does not duplicate", unique + " distinct");

      const wide = rows.map((r) => String(r.CompanyName ?? "")).sort((a, b) => b.length - a.length)[0] || "";
      if (/\r|\n|…|\.\.\.$/.test(wide)) fail("wide values are not truncated", JSON.stringify(wide.slice(0, 60)));
      else pass("wide values are not truncated", "longest name " + wide.length + " chars");
      const nonAsciiNames = rows.filter((r) => /[^\x00-\x7F]/.test(String(r.CompanyName ?? "")));
      if (nonAsciiNames.length) pass("non-ASCII names intact", nonAsciiNames.length + " names with non-ASCII characters");
    } catch (e) {
      fail("debtor listing", redact(e.message).split("\n")[0].slice(0, 110));
    }
  }
}

// ------------------------------------------------------------------- verdict
console.log("");
if (failures) {
  console.log(failures + " FAILED" + (skipped ? ", " + skipped + " skipped" : "") +
    "\nDo not point this at live books until the guard section is clean.");
  process.exit(1);
}
console.log("All checks passed" + (skipped ? " (" + skipped + " skipped - not the same as passed)" : "") + ".");
if (skipped) console.log("Re-run once .env has credentials and ACCT_CLOUD_BOOKS is set.");
