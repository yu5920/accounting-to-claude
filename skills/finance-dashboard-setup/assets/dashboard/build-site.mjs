// Packages dashboard.html into a folder Netlify can deploy.
//
//   node build-site.mjs                     plain, no gate
//   node build-site.mjs --lock              gate it with the credentials below
//   node build-site.mjs --lock --id X --pw Y
//
// The gate is real encryption, not a hidden div. A static host serves whatever
// it is given, so a JavaScript "if (password === ...)" check protects nothing:
// the reader can open the source and the whole dataset is sitting there. Here
// the payload is encrypted with AES-GCM under a key derived from the id and
// password, so without them the file is ciphertext and there is nothing to read.
//
// The honest limit: the ciphertext is public, so it can be attacked offline at
// the attacker's own pace. Strength rests entirely on the password.
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { webcrypto as crypto } from "node:crypto";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const SRC = opt("src", "dashboard.html");
const OUT = opt("out", "site");
const LOCK = flag("lock");
// No default credentials on purpose: a password baked into a shared script
// ends up published with the site by whoever forgets to override it.
const ID = opt("id", process.env.SITE_ID || "");
const PW = opt("pw", process.env.SITE_PW || "");
if (flag("lock") && (!ID || !PW)) {
  console.error("--lock needs credentials: node build-site.mjs --lock --id <user> --pw <password>");
  console.error("(or set SITE_ID / SITE_PW in the environment)");
  process.exit(1);
}
const BRAND = opt("brand", process.env.BRAND || "FINANCE");
const ITERATIONS = 310000;   // OWASP floor for PBKDF2-SHA256

mkdirSync(OUT, { recursive: true });
let html = readFileSync(SRC, "utf8");

if (LOCK) {
  // 1. Lift the data payload and the application code out of the page.
  const payloadRe = /<script type="application\/json" id="payload">([\s\S]*?)<\/script>/;
  const payloadMatch = html.match(payloadRe);
  if (!payloadMatch) throw new Error("找不到 payload script —— dashboard.html 结构变了？");

  const appRe = /<script>\n"use strict";([\s\S]*?)<\/script>/;
  const appMatch = html.match(appRe);
  if (!appMatch) throw new Error("找不到主程式 script —— dashboard.html 结构变了？");

  // Encrypt both together: the code is harmless, but shipping it in the clear
  // would leak the account names and structure through variable names.
  const secret = JSON.stringify({ payload: payloadMatch[1], app: appMatch[1] });

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(ID + ":" + PW), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, new TextEncoder().encode(secret)));

  const b64 = (u8) => Buffer.from(u8).toString("base64");

  // 2. Rebuild the page: empty payload, inert app, plus the gate.
  html = html.replace(payloadRe, '<script type="application/json" id="payload">{}</script>');
  html = html.replace(appRe, "");

  const gate = `
<div id="gate">
  <form id="gateForm" autocomplete="on">
    <h1>${BRAND}</h1>
    <p class="gsub">集团财务分析 · Group Finance Cockpit</p>
    <label for="gid">帐号 ID</label>
    <input id="gid" name="username" type="text" autocomplete="username" autocapitalize="off"
           autocorrect="off" spellcheck="false" required>
    <label for="gpw">密码 Password</label>
    <input id="gpw" name="password" type="password" autocomplete="current-password" required>
    <button type="submit" id="gbtn">进入 Enter</button>
    <p class="gmsg" id="gmsg" hidden></p>
    <p class="gnote">这份报表包含集团完整财务资料，请勿转发连结与帐密。</p>
  </form>
</div>
<style>
#gate{position:fixed;inset:0;z-index:9999;background:#12413F;color:#F6F1E8;
  display:grid;place-items:center;padding:24px;
  font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif}
#gateForm{width:min(340px,100%);display:flex;flex-direction:column}
#gate h1{margin:0;font-size:26px;letter-spacing:.06em;font-weight:700}
#gate .gsub{margin:4px 0 26px;font-size:12.5px;opacity:.7}
#gate label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  opacity:.75;margin-bottom:5px}
#gate input{font:inherit;font-size:15px;padding:9px 11px;margin-bottom:16px;border-radius:6px;
  border:1px solid rgba(246,241,232,.25);background:rgba(246,241,232,.08);color:#F6F1E8}
#gate input:focus{outline:2px solid #BDAF94;outline-offset:1px}
#gate button{font:inherit;font-size:14px;font-weight:600;padding:10px;border:none;
  border-radius:6px;background:#BDAF94;color:#22312E;cursor:pointer;margin-top:4px}
#gate button:hover{filter:brightness(1.07)}
#gate button[disabled]{opacity:.6;cursor:progress}
#gate .gmsg{margin:14px 0 0;font-size:12.5px;color:#F2B8B2;min-height:1em}
#gate .gnote{margin:26px 0 0;font-size:11px;opacity:.55;line-height:1.6}
</style>
<script>
(function () {
  "use strict";
  var BLOB = { s: "${b64(salt)}", i: "${b64(iv)}", c: "${b64(cipher)}", n: ${ITERATIONS} };
  var raw = function (b) {
    var s = atob(b), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  };
  var form = document.getElementById("gateForm");
  var msg = document.getElementById("gmsg");
  var btn = document.getElementById("gbtn");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = document.getElementById("gid").value.trim();
    var pw = document.getElementById("gpw").value;
    btn.disabled = true; btn.textContent = "解密中…"; msg.hidden = true;

    crypto.subtle.importKey("raw", new TextEncoder().encode(id + ":" + pw),
        "PBKDF2", false, ["deriveKey"])
      .then(function (m) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: raw(BLOB.s), iterations: BLOB.n, hash: "SHA-256" },
          m, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      })
      .then(function (k) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: raw(BLOB.i) }, k, raw(BLOB.c));
      })
      .then(function (buf) {
        var parts = JSON.parse(new TextDecoder().decode(buf));
        document.getElementById("payload").textContent = parts.payload;
        var s = document.createElement("script");
        s.textContent = '"use strict";' + parts.app;
        document.body.appendChild(s);
        var g = document.getElementById("gate");
        g.parentNode.removeChild(g);
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = "进入 Enter";
        msg.textContent = "帐号或密码不对。";
        msg.hidden = false;
        document.getElementById("gpw").value = "";
        document.getElementById("gpw").focus();
      });
  });
  document.getElementById("gid").focus();
})();
</script>
`;
  html += gate;
}

writeFileSync(join(OUT, "index.html"), html, "utf8");

writeFileSync(join(OUT, "_headers"),
`/*
  Cache-Control: no-store, max-age=0, must-revalidate
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
`, "utf8");

writeFileSync(join(OUT, "robots.txt"), "User-agent: *\nDisallow: /\n", "utf8");

const kb = Math.round(statSync(join(OUT, "index.html")).size / 1024);
console.log("Wrote " + OUT + "/  (index.html " + kb.toLocaleString() + " KB" +
  (LOCK ? "，已加密，帐号 " + ID : "，未加密") + ")");
