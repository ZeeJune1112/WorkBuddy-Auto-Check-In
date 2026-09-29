#!/usr/bin/env node
"use strict";
/* ============================================================
 * wbipc-checkin.js — 通过 WorkBuddy 桌面端 wbipc 通道执行每日签到
 *
 * 原理（逆向自桌面端 5.6.2 main/server.js 的 packages/workbuddy-server/src/wbipc）：
 *   桌面端主进程内置 wbipc broker（Windows named pipe / unix socket），对外提供
 *   `wb.request` 管道的 `http.fetch` 方法：调用方只传相对路径，服务端自动注入
 *   当前登录账号的鉴权头（Authorization / X-User-Id，企业账号另带
 *   X-Enterprise-Id / X-Tenant-Id）后转发到官方后端。
 *   —— 凭据全程只在主进程内存里，本脚本接触不到令牌，也不需要拿到令牌。
 *   发现文件由桌面端写入 `<configDir>/wbipc/endpoint.json`：
 *   { "endpoint": "\\\\.\\pipe\\wbipc-<id>", "ticket": "<32B base64url>" }
 *
 * 握手协议（换行分帧 JSON，帧限 1MiB）：
 *   C→S session_hello   { protocol_min:1, protocol_max:1, client_nonce,
 *                         ticket_id: sha256(ticket) 前 16 hex, client:{...} }
 *   S→C session_challenge { protocol:1, server_nonce, server_proof }
 *       proof = HMAC-SHA256(ticket, transcript)；transcript = 长度前缀拼接
 *       [ "wbipc-s"|"wbipc-c", "1", endpoint, clientNonce, serverNonce ]
 *   C→S session_prove   { client_proof }（校验失败/超时(5s)即断连）
 *   S→C session_hello_ack { connection_epoch, max_inflight, pipes }
 *   之后 JSON-RPC 2.0：broker/GetPipe → channel "c:wb.request"；
 *   调用 `c:wb.request/http.fetch` 必须带 mode:"call"。
 *
 * 注意（实测踩坑）：Windows named pipe 在 connect 事件后立即 write 会随机
 * EPIPE，延迟 ~250ms 再写则稳定。本脚本已内置该 workaround。
 *
 * stdout 结果行（供 checkin.ps1 / checkin.sh 解析；日志中不落任何令牌）：
 *   WBIPC_RESULT=OK credit=<n> streak_days=<n>     签到成功
 *   WBIPC_RESULT=ALREADY                            今日已签到（幂等）
 *   WBIPC_RESULT=FAIL code=<c> msg=<m>              业务拒绝（如企业账号限制）
 *   WBIPC_ERROR=<REASON> <detail>                   基础设施失败（调用方应回退旧通道）
 * 退出码：0 = OK / ALREADY；1 = FAIL（业务拒绝）；2 = ERROR（基础设施失败）
 * ============================================================ */

const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const crypto = require("crypto");

const CONNECT_DELAY_MS = 250;   // Windows named pipe 时序 workaround
const HANDSHAKE_TIMEOUT_MS = 6000;
const REQUEST_TIMEOUT_MS = 55000; // 服务端上游超时 50s，留余量
const CONNECT_RETRIES = 3;
const RETRY_INTERVAL_MS = 1200;

function fail(reason, detail) {
  process.stdout.write("WBIPC_ERROR=" + reason + (detail ? " " + String(detail).replace(/\s+/g, " ").slice(0, 160) : "") + "\n");
  process.exit(2);
}

// ---------- 发现文件 ----------
const configDir = process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(), ".workbuddy");
const epFile = path.join(configDir, "wbipc", "endpoint.json");
if (!fs.existsSync(epFile)) {
  fail("NO_BROKER", "wbipc endpoint.json not found at " + epFile + "（桌面端未运行、未登录，或版本过旧不支持 wbipc）");
}
let ep;
try { ep = JSON.parse(fs.readFileSync(epFile, "utf8")); } catch (e) { fail("BAD_ENDPOINT", e.message); }
const endpoint = ep.endpoint, ticket = ep.ticket;
if (!endpoint || !ticket) fail("BAD_ENDPOINT", "endpoint.json missing endpoint/ticket fields");

// ---------- 握手原语 ----------
const ticketId = crypto.createHash("sha256").update(ticket, "utf8").digest("hex").slice(0, 16);
const clientNonce = crypto.randomBytes(16).toString("base64url");
function encodeTranscript(role, t) {
  const parts = [role === "server" ? "wbipc-s" : "wbipc-c", String(t.protocol), t.endpoint, t.clientNonce, t.serverNonce];
  const chunks = [];
  for (const p of parts) {
    const b = Buffer.from(p, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    chunks.push(len, b);
  }
  return Buffer.concat(chunks);
}
const computeProof = (role, t) =>
  crypto.createHmac("sha256", Buffer.from(ticket, "utf8")).update(encodeTranscript(role, t)).digest("base64url");

// ---------- 一条连接上完成握手 + 两次 RPC ----------
function runOnce() {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let state = "connecting";
    let nextId = 1;
    const pending = new Map();
    const socket = net.connect({ path: endpoint });
    socket.setNoDelay(true);

    const hardTimer = setTimeout(() => {
      cleanup();
      reject(new Error("TIMEOUT overall"));
    }, HANDSHAKE_TIMEOUT_MS + REQUEST_TIMEOUT_MS * 2 + 5000);

    function cleanup() {
      clearTimeout(hardTimer);
      try { socket.destroy(); } catch (_) {}
    }
    function send(obj) {
      socket.write(Buffer.from(JSON.stringify(obj) + "\n", "utf8"));
    }
    function onFrame(f) {
      if (state === "hello" && f.type === "session_challenge") {
        const t = { protocol: 1, endpoint, clientNonce, serverNonce: f.server_nonce };
        if (computeProof("server", t) !== f.server_proof) {
          cleanup(); reject(new Error("ENDPOINT_UNTRUSTED 服务端证明校验失败")); return;
        }
        state = "prove";
        send({ type: "session_prove", client_proof: computeProof("client", t) });
        return;
      }
      if (state === "prove" && f.type === "session_hello_ack") {
        state = "ready";
        // 握手完成；后续逐请求计时
        const gpId = nextId++;
        const gpWait = new Promise((res) => pending.set(gpId, res));
        send({ jsonrpc: "2.0", id: gpId, method: "broker/GetPipe", params: { pipe: "wb.request" } });
        gpWait.then((gp) => {
          if (gp.error) throw new Error("GETPIPE " + JSON.stringify(gp.error));
          const channel = gp.result.channel;
          const post = (p) => new Promise((res) => {
            const id = nextId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              res({ __timeout: true });
            }, REQUEST_TIMEOUT_MS);
            pending.set(id, (f2) => { clearTimeout(timer); res(f2); });
            send({ jsonrpc: "2.0", id, method: channel + "/http.fetch", mode: "call",
              params: { method: "POST", path: p, headers: { "content-type": "application/json" },
                body_b64: Buffer.from("{}").toString("base64") } });
          });
          Promise.all([post("/billing/meter/checkin-status"), post("/v2/billing/meter/daily-checkin")])
            .then(([st, ci]) => { cleanup(); resolve({ st, ci }); })
            .catch((e) => reject(e));
        }).catch((e) => { cleanup(); reject(e); });
        return;
      }
      if (f.jsonrpc && f.id !== undefined) {
        const w = pending.get(f.id);
        if (w) { pending.delete(f.id); w(f); }
      }
    }
    socket.on("connect", () => {
      state = "hello";
      setTimeout(() => {
        if (state !== "hello") return;
        send({ type: "session_hello", protocol_min: 1, protocol_max: 1, client_nonce: clientNonce,
          ticket_id: ticketId, client: { kind: "checkin-script", id: "wbipc-checkin", version: "1.0.0" } });
      }, CONNECT_DELAY_MS);
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 1);
        if (!line) continue;
        let f;
        try { f = JSON.parse(line); } catch (_) { cleanup(); reject(new Error("PROTOCOL malformed frame")); return; }
        try { onFrame(f); } catch (e) { cleanup(); reject(e); return; }
      }
    });
    socket.on("error", (e) => { cleanup(); reject(new Error("SOCKET " + e.message)); });
    socket.on("close", () => { cleanup(); reject(new Error("SOCKET closed early (state=" + state + ")")); });
  });
}

(async () => {
  let lastErr = null;
  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
    try {
      const { st, ci } = await runOnce();

      // ---- 状态查询（仅诊断与快速短路；幂等兜底以 daily-checkin 的 msg 为准）----
      if (st.__timeout) process.stderr.write("[wbipc] checkin-status timeout, continue to daily-checkin\n");
      else if (st.error) process.stderr.write("[wbipc] checkin-status error: " + JSON.stringify(st.error).slice(0, 160) + "\n");
      else {
        try {
          const sb = JSON.parse(Buffer.from(st.result.body_b64, "base64").toString("utf8"));
          const d = sb.data || {};
          process.stderr.write("[wbipc] status http=" + st.result.status + " code=" + sb.code +
            " today_checked_in=" + d.today_checked_in + " total_credits=" + d.total_credits + "\n");
          if (sb.code === 0 && d.today_checked_in === true) {
            process.stdout.write("WBIPC_RESULT=ALREADY\n");
            process.exit(0);
          }
        } catch (_) { /* 状态解析失败不阻塞签到 */ }
      }

      // ---- 签到 ----
      if (ci.__timeout) fail("TIMEOUT", "daily-checkin upstream timeout");
      if (ci.error) fail("UPSTREAM", JSON.stringify(ci.error).slice(0, 160));
      const httpStatus = ci.result.status;
      const bodyStr = Buffer.from(ci.result.body_b64, "base64").toString("utf8");
      let b;
      try { b = JSON.parse(bodyStr); } catch (_) { fail("BAD_RESPONSE", "http=" + httpStatus + " body=" + bodyStr.slice(0, 120)); }
      if (b.code === 0 && b.data) {
        process.stdout.write("WBIPC_RESULT=OK credit=" + b.data.credit + " streak_days=" + b.data.streak_days + "\n");
        process.exit(0);
      }
      const msg = String(b.msg || "");
      if (/已签到|already.{0,20}checked|checked.{0,20}in/i.test(msg)) {
        process.stdout.write("WBIPC_RESULT=ALREADY\n");
        process.exit(0);
      }
      process.stdout.write("WBIPC_RESULT=FAIL code=" + b.code + " msg=" + msg.replace(/\s+/g, " ").slice(0, 120) + " http=" + httpStatus + "\n");
      process.exit(1);
    } catch (e) {
      lastErr = e;
      // 握手期/连接期失败可重试；业务结果不会走到这里
      if (attempt < CONNECT_RETRIES) await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    }
  }
  fail("CONNECT_FAILED", lastErr ? lastErr.message : "unknown");
})();
