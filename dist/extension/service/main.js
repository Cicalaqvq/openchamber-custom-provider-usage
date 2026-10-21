"use strict";
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));

  // src/service.ts
  var import_node_http = __toESM(__require("node:http"));

  // src/sites.ts
  var PRIVATE_HOST = /^(localhost|[^.]+\.localhost|[^.]+\.local|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|::1|\[::1\])$/iu;
  function validateUserId(value) {
    if (value === void 0) return { ok: true };
    if (typeof value !== "string") return { ok: false };
    const trimmed = value.trim();
    if (!trimmed) return { ok: true };
    if (!/^[1-9]\d*$/u.test(trimmed)) return { ok: false };
    const number = Number(trimmed);
    if (!Number.isSafeInteger(number) || number < 1) return { ok: false };
    return { ok: true, userId: String(number) };
  }
  function failOrigin(message) {
    return { ok: false, message };
  }
  function isPrivateHost(hostname) {
    return PRIVATE_HOST.test(hostname);
  }
  function normalizeOrigin(input) {
    const raw = typeof input === "string" ? input.trim() : "";
    if (!raw) return failOrigin("请填写中转站地址。");
    if (raw.length > 2048) return failOrigin("地址过长。");
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return failOrigin("地址格式无效，请填写形如 https://relay.example.com 的根地址。");
    }
    if (url.username || url.password) return failOrigin("地址中不能包含账号或密码。");
    if (url.protocol !== "https:" && url.protocol !== "http:") return failOrigin("只支持 https 地址。");
    if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
      return failOrigin("公网中转站必须使用 https；http 仅允许本机或内网地址。");
    }
    if (url.search || url.hash) return failOrigin("地址不能包含查询参数或片段。");
    if (url.pathname !== "/" && url.pathname.replace(/\/+$/u, "") !== "") {
      return failOrigin("只填写根地址，不要包含路径（例如 https://relay.example.com）。");
    }
    return { ok: true, origin: url.origin };
  }

  // src/service.ts
  var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
  if (!port || !token) {
    console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
    process.exit(1);
  }
  var FETCH_TIMEOUT_MS = 12e3;
  var MAX_BODY_BYTES = 1e6;
  var MAX_REQUEST_BYTES = 16e3;
  var MAX_PATH_LENGTH = 512;
  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
          chunks.length = 0;
          req.destroy();
          resolve(void 0);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(size > MAX_REQUEST_BYTES ? void 0 : Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(void 0));
    });
  }
  function safePath(value) {
    if (typeof value !== "string") return void 0;
    const path = value.trim();
    if (path.length < 2 || path.length > MAX_PATH_LENGTH) return void 0;
    if (!path.startsWith("/") || path.startsWith("//")) return void 0;
    if (/[\u0000-\u001f\u007f\\]/u.test(path)) return void 0;
    if (path.includes("://") || path.includes("..")) return void 0;
    if (path.includes("?") || path.includes("#")) return void 0;
    return path;
  }
  function safeToken(value) {
    if (typeof value !== "string") return void 0;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 512) return void 0;
    if (/[\u0000-\u001f\u007f\s]/u.test(trimmed)) return void 0;
    return trimmed;
  }
  async function proxy(originInput, bearer, path, userId) {
    const normalized = normalizeOrigin(originInput);
    if (!normalized.ok) throw new Error("BAD_ORIGIN");
    const url = new URL(path, `${normalized.origin}/`);
    if (url.origin !== normalized.origin) throw new Error("BAD_ORIGIN");
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${bearer}`, ...userId ? { "New-Api-User": userId } : {} },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BODY_BYTES) throw new Error("RESPONSE_TOO_LARGE");
    return { status: response.status, body: buffer.toString("utf8") };
  }
  var server = import_node_http.default.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, { error: "UNAUTHORIZED" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname !== "/proxy") {
      send(res, 404, { error: "NOT_FOUND" });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }
    void (async () => {
      const raw = await readBody(req);
      if (raw === void 0) {
        send(res, 413, { error: "REQUEST_TOO_LARGE" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        send(res, 400, { error: "BAD_REQUEST" });
        return;
      }
      const path = safePath(payload.path);
      const bearer = safeToken(payload.token);
      const userId = validateUserId(payload.userId);
      const origin = typeof payload.origin === "string" ? payload.origin : "";
      if (!path) {
        send(res, 400, { error: "BAD_PATH" });
        return;
      }
      if (!bearer) {
        send(res, 400, { error: "BAD_TOKEN" });
        return;
      }
      if (!userId.ok) {
        send(res, 400, { error: "BAD_USER_ID" });
        return;
      }
      try {
        const result = await proxy(origin, bearer, path, userId.userId);
        send(res, 200, result);
      } catch (error) {
        const code = error instanceof Error ? error.message : "NETWORK";
        send(res, 502, { error: /^(BAD_ORIGIN|RESPONSE_TOO_LARGE)$/u.test(code) ? code : "NETWORK" });
      }
    })();
  });
  server.listen(port, "127.0.0.1");
})();
