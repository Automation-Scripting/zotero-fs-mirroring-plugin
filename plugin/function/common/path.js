// function/common/path.js

var PathUtils = globalThis.PathUtils;

// --------------------
// path helpers
// --------------------
function _norm(p) { return String(p || "").replace(/\/+/g, "/"); }
function _looksAbsolute(p) { return _norm(p).startsWith("/"); }
function _isProbablyStored(p) { return _norm(p).includes("/storage/"); } // não mexer em storage do Zotero
function _baseName(p) { const s = _norm(p); return s.split("/").pop() || ""; }
function _parentDir(p) { return PathUtils.parent(_norm(p)); }