"use strict";
/*
 * axis.js — Axis (Odoo 19) XML-RPC client for the PES quote proxy.
 *
 * Every call is logged (console + web/logs/axis-calls.log as JSONL) with the
 * model, method, domain/ids, and elapsed ms. The API key is a positional
 * argument to execute_kw and is NEVER logged.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { encodeCall, decodeResponse, XmlRpcFault } = require("./xmlrpc");

const LOG_DIR = path.join(__dirname, "logs");

class AxisClient {
  constructor({ url, db, user, apiKey }) {
    this.url = url;
    this.db = db;
    this.user = user;
    this.apiKey = apiKey; // never logged
    this.uid = null;
    this.callLog = []; // in-memory call sequence for the current process
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      this.logStream = fs.createWriteStream(path.join(LOG_DIR, "axis-calls.log"), { flags: "a" });
    } catch {
      this.logStream = null;
    }
  }

  _log(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    this.callLog.push(entry);
    console.log("[axis]", line);
    if (this.logStream) this.logStream.write(line + "\n");
  }

  _post(service, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(`${this.url}/xmlrpc/2/${service}`);
      const req = https.request(
        {
          method: "POST",
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname,
          headers: {
            "Content-Type": "text/xml",
            "Content-Length": Buffer.byteLength(body),
            "User-Agent": "pes-quote-proxy/0.1",
          },
          timeout: 30000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) {
              reject(new Error(`Axis HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
              return;
            }
            resolve(text);
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("Axis request timed out (30s)")));
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  async _rawCall(service, method, params) {
    const started = Date.now();
    const body = encodeCall(method, params);
    const xml = await this._post(service, body);
    const result = decodeResponse(xml);
    return { result, ms: Date.now() - started };
  }

  async version() {
    const { result } = await this._rawCall("common", "version", []);
    return result;
  }

  async authenticate() {
    // NOTE: the API key travels only inside this call body; _rawCall never logs params.
    const { result, ms } = await this._rawCall("common", "authenticate", [
      this.db, this.user, this.apiKey, {},
    ]);
    this.uid = result;
    this._log({ op: "authenticate", db: this.db, user: this.user, uid: result, ms });
    if (!this.uid) throw new Error("Axis authentication failed (bad credentials or DB)");
    return this.uid;
  }

  async _ensureUid() {
    if (!this.uid) await this.authenticate();
    return this.uid;
  }

  /**
   * execute_kw wrapper. `logMeta` describes the call for the log
   * (model, method, domain/ids/kwarg-fields — never the API key).
   */
  async executeKw(model, method, args, kwargs = {}) {
    await this._ensureUid();
    const started = Date.now();
    const body = encodeCall("execute_kw", [this.db, this.uid, this.apiKey, model, method, args, kwargs]);
    const xml = await this._post("object", body);
    try {
      const result = decodeResponse(xml);
      this._log({
        op: "execute_kw",
        model,
        method,
        summary: summarize(model, method, args, kwargs),
        ms: Date.now() - started,
      });
      return result;
    } catch (e) {
      this._log({
        op: "execute_kw",
        model,
        method,
        summary: summarize(model, method, args, kwargs),
        error: e instanceof XmlRpcFault ? e.faultString : e.message,
        ms: Date.now() - started,
      });
      throw e;
    }
  }

  search(model, domain, opts = {}) {
    return this.executeKw(model, "search", [domain], opts);
  }
  searchRead(model, domain, fields, opts = {}) {
    return this.executeKw(model, "search_read", [domain], { fields, ...opts });
  }
  read(model, ids, fields) {
    return this.executeKw(model, "read", [ids], { fields });
  }
  create(model, vals) {
    return this.executeKw(model, "create", [vals]);
  }
  write(model, ids, vals) {
    return this.executeKw(model, "write", [ids, vals]);
  }
  unlink(model, ids) {
    return this.executeKw(model, "unlink", [ids]);
  }
}

function summarize(model, method, args, kwargs) {
  const s = { model, method };
  if (method === "search" || method === "search_read" || method === "search_count") {
    s.domain = args[0];
    if (kwargs && kwargs.fields) s.fields = kwargs.fields;
    if (kwargs && kwargs.limit) s.limit = kwargs.limit;
  } else if (method === "read") {
    s.ids = args[0];
    s.fields = args[1] || (kwargs && kwargs.fields);
  } else if (method === "create") {
    s.keys = Object.keys(args[0] || {});
    if (args[0] && args[0].client_order_ref) s.client_order_ref = args[0].client_order_ref;
  } else if (method === "write") {
    s.ids = args[0];
    s.keys = Object.keys(args[1] || {});
  } else if (method === "unlink") {
    s.ids = args[0];
  }
  return s;
}

module.exports = { AxisClient };
