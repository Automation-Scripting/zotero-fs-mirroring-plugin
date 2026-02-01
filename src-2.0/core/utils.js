// core/utils.js

var IOUtils = globalThis.IOUtils;
var PathUtils = globalThis.PathUtils;

function _ts() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`;
}

function _dateStamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// join simples (não depende de OS.Path)
function _joinPath(...parts) {
  return parts.join("/").replace(/\/+/g, "/");
}