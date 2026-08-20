// Proves the locked site actually opens with the intended credentials, and
// refuses everything else.
//
// The separator is read out of the generated page and interpreted the way a
// browser would (JSON.parse handles the same escapes JavaScript does). An
// earlier version of this check translated the escape by hand, which quietly
// made a broken build look fine - do not reintroduce that.
import { readFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const ID = process.argv[2] || process.env.SITE_ID || "";
const PW = process.argv[3] || process.env.SITE_PW || "";
if (!ID || !PW) {
  console.error("usage: node verify-lock.mjs <id> <password>   (or set SITE_ID / SITE_PW)");
  process.exit(1);
}
const html = readFileSync("site/index.html", "utf8");

const blob = html.match(/var BLOB = \{ s: "([^"]+)", i: "([^"]+)", c: "([^"]+)", n: (\d+) \}/);
if (!blob) { console.log("FAIL  找不到加密区块 —— 这份 index.html 没有上锁"); process.exit(1); }
const [, sB64, iB64, cB64, iterStr] = blob;
const iterations = Number(iterStr);

const sepMatch = html.match(/encode\(id \+ ("(?:[^"\\]|\\.)*") \+ pw\)/);
if (!sepMatch) { console.log("FAIL  找不到浏览器端的金钥推导写法"); process.exit(1); }
const sep = JSON.parse(sepMatch[1]);
console.log("页面实际使用的分隔符号：" + JSON.stringify(sep) +
            "（长度 " + sep.length + "）");

const raw = (b) => new Uint8Array(Buffer.from(b, "base64"));

async function tryOpen(id, pw) {
  try {
    const m = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(id + sep + pw), "PBKDF2", false, ["deriveKey"]);
    const k = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: raw(sB64), iterations, hash: "SHA-256" },
      m, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw(iB64) }, k, raw(cB64));
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

let ok = true;
const t0 = Date.now();
const good = await tryOpen(ID, PW);
const ms = Date.now() - t0;

if (!good) {
  console.log("FAIL  正确帐密解不开 —— 加密端与解密端的金钥推导不一致");
  ok = false;
} else {
  const data = JSON.parse(good.payload);
  const txns = data.companies.reduce((s, c) => s + ((c.txns || []).length), 0);
  console.log("PASS  正确帐密解得开（" + ms + " ms）");
  console.log("      还原出 " + data.companies.length + " 间公司、" +
              txns.toLocaleString() + " 笔分录、" + data.months.length + " 个月");
  if (!good.app || good.app.length < 10000) {
    console.log("FAIL  程式码没有一起还原，页面会打不开"); ok = false;
  } else {
    console.log("PASS  程式码一并还原（" + Math.round(good.app.length / 1024) + " KB）");
  }
}

for (const [id, pw, label] of [
  [ID, PW + "x", "密码多一个字"],
  [ID, PW.slice(0, -1), "密码少一个字"],
  [ID.toUpperCase() === ID ? ID.toLowerCase() : ID.toUpperCase(), PW, "帐号大小写不同"],
  ["", "", "空白"],
]) {
  const r = await tryOpen(id, pw);
  if (r) { console.log("FAIL  " + label + " 竟然也解得开"); ok = false; }
  else console.log("PASS  " + label + " 被拒绝");
}

// The plaintext must not be sitting in the file next to the ciphertext.
// Sample the real names out of the source data rather than hard-coding a list:
// a fixed list quietly stops meaning anything the moment someone runs this
// against different books.
function sampleNames() {
  let d;
  try { d = JSON.parse(readFileSync("dashboard-data.json", "utf8")); } catch { return []; }
  const out = [];
  for (const c of (d.companies || []).slice(0, 5)) {
    out.push(c.name);
    for (const a of (c.revenueAccounts || []).slice(0, 3)) out.push(a.name);
    for (const a of (c.expenses || []).slice(0, 3)) out.push(a.name);
    for (const p of (c.parties || []).slice(0, 3)) out.push(p);
  }
  // Short or generic strings match by accident; only distinctive names prove anything.
  return [...new Set(out.filter((n) => typeof n === "string" && n.trim().length >= 8))];
}

const names = sampleNames();
if (!names.length) {
  console.log("SKIP  找不到 dashboard-data.json，无法核对明文外泄");
} else {
  const leaks = names.filter((p) => html.includes(p));
  if (leaks.length) {
    console.log("FAIL  未加密的资料外泄，页面里直接找得到：" + leaks.slice(0, 5).join("、"));
    ok = false;
  } else {
    console.log("PASS  抽查 " + names.length + " 个真实科目／公司／客户名称，页面里都找不到明文");
  }
}

console.log(ok ? "\n全部通过。" : "\n有项目失败。");
process.exit(ok ? 0 : 1);
