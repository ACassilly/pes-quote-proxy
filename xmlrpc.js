"use strict";
/*
 * xmlrpc.js — zero-dependency XML-RPC codec for Odoo's /xmlrpc/2 endpoints.
 *
 * Serializer: JS values -> XML-RPC <value> payloads.
 * Parser: minimal well-formed-XML walker sufficient for Odoo responses
 * (params/fault, structs, arrays, scalars, nil, CDATA, entities, comments).
 *
 * SECURITY: call sites must never pass secrets in `params`; the password is
 * an execute_kw positional argument and is redacted by the logger in axis.js.
 */

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function encodeValue(v) {
  if (v === null || v === undefined) return "<value><nil/></value>";
  if (typeof v === "boolean")
    return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("XML-RPC: non-finite number");
    return Number.isInteger(v)
      ? `<value><int>${v}</int></value>`
      : `<value><double>${v}</double></value>`;
  }
  if (typeof v === "string") return `<value><string>${esc(v)}</string></value>`;
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(encodeValue).join("")}</data></array></value>`;
  }
  if (typeof v === "object") {
    const members = Object.entries(v)
      .map(([k, val]) => `<member><name>${esc(k)}</name>${encodeValue(val)}</member>`)
      .join("");
    return `<value><struct>${members}</struct></value>`;
  }
  throw new Error("XML-RPC: unsupported value type " + typeof v);
}

function encodeCall(methodName, params) {
  const ps = params.map((p) => `<param>${encodeValue(p)}</param>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<methodCall><methodName>${methodName}</methodName><params>${ps}</params></methodCall>`;
}

/* ---------------- minimal XML parser ---------------- */

function parseXml(src) {
  let i = 0;
  const n = src.length;

  function err(msg) {
    throw new Error(`XML parse error at byte ${i}: ${msg}`);
  }

  function skipMisc() {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i + 4);
        if (end === -1) err("unterminated comment");
        i = end + 3;
      } else if (src.startsWith("<?", i)) {
        const end = src.indexOf("?>", i + 2);
        if (end === -1) err("unterminated PI");
        i = end + 2;
      } else if (src.startsWith("<!DOCTYPE", i)) {
        const end = src.indexOf(">", i + 9);
        if (end === -1) err("unterminated DOCTYPE");
        i = end + 1;
      } else {
        return;
      }
    }
  }

  function decodeEntities(text) {
    return text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, "&");
  }

  function parseName() {
    const m = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(src.slice(i));
    if (!m) err("expected element name");
    i += m[0].length;
    return m[0];
  }

  function parseNode() {
    if (src[i] !== "<") err("expected '<'");
    i++;
    const name = parseName();
    const attrs = {};
    // attributes
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src.startsWith("/>", i)) {
        i += 2;
        return { name, attrs, children: [], text: "" };
      }
      if (src[i] === ">") {
        i++;
        break;
      }
      const an = parseName();
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] !== "=") err("expected '=' in attribute");
      i++;
      while (i < n && /\s/.test(src[i])) i++;
      const q = src[i];
      if (q !== '"' && q !== "'") err("expected quoted attribute value");
      const end = src.indexOf(q, i + 1);
      if (end === -1) err("unterminated attribute value");
      attrs[an] = decodeEntities(src.slice(i + 1, end));
      i = end + 1;
    }
    // content
    const children = [];
    let text = "";
    for (;;) {
      if (i >= n) err("unexpected EOF inside element " + name);
      if (src.startsWith("<![CDATA[", i)) {
        const end = src.indexOf("]]>", i + 9);
        if (end === -1) err("unterminated CDATA");
        text += src.slice(i + 9, end);
        i = end + 3;
      } else if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i + 4);
        if (end === -1) err("unterminated comment");
        i = end + 3;
      } else if (src.startsWith("</", i)) {
        const close = parseName2();
        if (close !== name) err(`mismatched close tag </${close}> for <${name}>`);
        return { name, attrs, children, text };
      } else if (src[i] === "<") {
        children.push(parseNode());
      } else {
        const next = src.indexOf("<", i);
        if (next === -1) err("text runs to EOF");
        text += decodeEntities(src.slice(i, next));
        i = next;
      }
    }

    function parseName2() {
      i += 2; // skip '</'
      const nm = parseName();
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] !== ">") err("expected '>' in close tag");
      i++;
      return nm;
    }
  }

  skipMisc();
  const root = parseNode();
  skipMisc();
  return root;
}

/* ---------------- XML-RPC value decoding ---------------- */

function firstElement(node) {
  return node.children.length ? node.children[0] : null;
}

function decodeValue(node) {
  // <value> with no typed child is a string per spec.
  const child = firstElement(node);
  if (!child) return node.text;
  switch (child.name) {
    case "string":
      return child.text;
    case "int":
    case "i4":
    case "i8":
      return parseInt(child.text.trim(), 10);
    case "double":
      return parseFloat(child.text.trim());
    case "boolean":
      return child.text.trim() === "1";
    case "nil":
      return null;
    case "base64":
      return child.text; // not needed for this project; kept raw
    case "dateTime.iso8601":
      return child.text.trim();
    case "array": {
      const data = firstElement(child); // <data>
      if (!data) return [];
      return data.children.map(decodeValue);
    }
    case "struct": {
      const out = {};
      for (const member of child.children) {
        if (member.name !== "member") continue;
        const nameNode = member.children.find((c) => c.name === "name");
        const valueNode = member.children.find((c) => c.name === "value");
        if (nameNode && valueNode) out[nameNode.text] = decodeValue(valueNode);
      }
      return out;
    }
    default:
      throw new Error("XML-RPC: unknown value tag <" + child.name + ">");
  }
}

class XmlRpcFault extends Error {
  constructor(code, message) {
    super(`XML-RPC fault ${code}: ${message}`);
    this.faultCode = code;
    this.faultString = message;
  }
}

function decodeResponse(xmlText) {
  const root = parseXml(xmlText);
  if (root.name !== "methodResponse")
    throw new Error("XML-RPC: unexpected root <" + root.name + ">");
  const fault = root.children.find((c) => c.name === "fault");
  if (fault) {
    const val = firstElement(fault);
    const s = val ? decodeValue(val) : {};
    throw new XmlRpcFault(s.faultCode ?? -1, s.faultString ?? "unknown fault");
  }
  const params = root.children.find((c) => c.name === "params");
  if (!params) return null;
  const param = params.children.find((c) => c.name === "param");
  if (!param) return null;
  const value = firstElement(param);
  return value ? decodeValue(value) : null;
}

module.exports = { encodeCall, decodeResponse, XmlRpcFault };
