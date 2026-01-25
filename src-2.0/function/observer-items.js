// function/observer-items.js

var IOUtils = globalThis.IOUtils;
var PathUtils = globalThis.PathUtils;

// --------------------
// helpers (top-level)
// --------------------
function _norm(p) { return String(p || "").replace(/\/+/g, "/"); }
function _looksAbsolute(p) { return _norm(p).startsWith("/"); }
function _isProbablyStored(p) { return _norm(p).includes("/storage/"); } // não mexer em storage do Zotero
function _baseName(p) { const s = _norm(p); return s.split("/").pop() || ""; }
function _parentDir(p) { return PathUtils.parent(_norm(p)); }

async function _exists(p) {
    try { return await IOUtils.exists(_norm(p)); } catch { return false; }
}
async function _ensureDir(p) {
    return IOUtils.makeDirectory(_norm(p), { createAncestors: true });
}
async function _copyFile(src, dst) {
    src = _norm(src); dst = _norm(dst);
    const constBytes = await IOUtils.read(src);
    await _ensureDir(_parentDir(dst));
    await IOUtils.write(dst, constBytes);
}
async function _moveFile(src, dst) {
    await _copyFile(src, dst);
    try { await IOUtils.remove(_norm(src)); } catch { }
}

// Regra de colisão: se dst existe -> (2), (3), ...
async function _uniquePath(dst) {
    dst = _norm(dst);
    if (!(await _exists(dst))) return dst;

    const dir = _parentDir(dst);
    const name = _baseName(dst);
    const m = name.match(/^(.*?)(\.[^.]*)$/); // foo.pdf
    const stem = m ? m[1] : name;
    const ext = m ? m[2] : "";

    for (let i = 2; i < 1000; i++) {
        const cand = _norm(`${dir}/${stem} (${i})${ext}`);
        if (!(await _exists(cand))) return cand;
    }
    return dst;
}

function _isAttachmentItem(item) {
    if (!item) return false;
    if (typeof item.isAttachment === "function") return !!item.isAttachment();
    return !!item.isAttachment;
}
function _isInTrash(item) {
    if (!item) return false;
    if (typeof item.isInTrash === "function") return !!item.isInTrash();
    if (typeof item.isInTrash === "boolean") return item.isInTrash;
    return false;
}

// --------------------
// LINKED path updater (robusto)
// --------------------
async function _setLinkedAttachmentPath(att, newPath) {
    const p = _norm(newPath);

    // 1) Tenta APIs "boas"
    try {
        if (typeof att.setFilePath === "function") {
            att.setFilePath(p);
            if (typeof att.saveTx === "function") await att.saveTx();
            return;
        }
        if (typeof att.setFilePathAsync === "function") {
            await att.setFilePathAsync(p);
            if (typeof att.saveTx === "function") await att.saveTx();
            return;
        }
        if ("attachmentPath" in att) {
            att.attachmentPath = p;
            if (typeof att.saveTx === "function") await att.saveTx();
            return;
        }
    } catch (e) {
        // cai no fallback
    }

    // 2) Fallback SQL: path de LINKED fica em itemAttachments.path
    await Zotero.DB.queryAsync(
        "UPDATE itemAttachments SET path=? WHERE itemID=?",
        [p, att.id]
    );

    try { if (typeof att.reload === "function") await att.reload(); } catch { }
}

function _trashDestForLinked({ rootDir, trashName, attKey, filename }) {
    const base = _norm(rootDir);
    const tname = trashName || "_FSMirror_Trash";
    return _norm(`${base}/${tname}/LINKED_TRASH/${attKey}/${filename}`);
}

// --------------------
// NOTE persistence
// --------------------
const _FSM_NOTE_HEADER = "FSMirror: linked-trash-map v1";

function _noteEncode(stateObj) {
    // texto simples + JSON (fácil de debugar)
    return `${_FSM_NOTE_HEADER}\n` +
        `---\n` +
        `${JSON.stringify(stateObj, null, 2)}\n`;
}

function _noteDecode(noteText) {
    const t = String(noteText || "");
    if (!t.startsWith(_FSM_NOTE_HEADER)) return null;
    const idx = t.indexOf("\n---\n");
    if (idx < 0) return null;
    const json = t.slice(idx + "\n---\n".length).trim();
    try { return JSON.parse(json); } catch { return null; }
}

async function _getOrCreateFSMirrorNote(parentItemID) {
    const parent = await Zotero.Items.getAsync(parentItemID);
    if (!parent) return null;

    const noteIDs = parent.getNotes?.() || [];
    for (const nid of noteIDs) {
        const n = await Zotero.Items.getAsync(nid);
        if (!n) continue;
        const txt = n.getNote?.() || n.getField?.("note") || "";
        if (String(txt).startsWith(_FSM_NOTE_HEADER)) return n;
    }

    // cria note
    const note = new Zotero.Item("note");
    note.parentItemID = parentItemID;
    note.setNote(_noteEncode({ byAttachmentID: {}, updatedAt: new Date().toISOString() }));
    const newID = await note.saveTx();
    return await Zotero.Items.getAsync(newID);
}

async function _readFSMirrorState(parentItemID) {
    const note = await _getOrCreateFSMirrorNote(parentItemID);
    if (!note) return null;
    const txt = note.getNote?.() || note.getField?.("note") || "";
    return _noteDecode(txt) || { byAttachmentID: {} };
}

async function _writeFSMirrorState(parentItemID, state) {
    const note = await _getOrCreateFSMirrorNote(parentItemID);
    if (!note) return;

    const next = state || { byAttachmentID: {} };
    next.updatedAt = new Date().toISOString();

    note.setNote(_noteEncode(next));
    await note.saveTx();
}

function _stateUpsert(state, attID, patch) {
    if (!state.byAttachmentID) state.byAttachmentID = {};
    const cur = state.byAttachmentID[String(attID)] || {};
    state.byAttachmentID[String(attID)] = { ...cur, ...patch };
    return state;
}

// --------------------
// Observer
// --------------------
var FS_ItemsObserver = {

    // ------------------------------------------------------------------
    // classificador original (mantém)
    // ------------------------------------------------------------------
    async onTrashOrDelete(api, event, ids) {
        const now = Date.now();
        if (!api._pendingCollectionDeletes || api._pendingCollectionDeletes.size === 0) return;

        for (const [colID, rec] of api._pendingCollectionDeletes.entries()) {
            if (now - rec.ts <= api._pendingTTLms) continue;

            if (rec.trashedItems.size === 0 && rec.deletedItems.size === 0) {
                api.info("COL",
                    `classify colID=${colID} => "Delete Collection (only)" (0 items trashed/deleted of ${rec.itemIDs.size})`
                );
            }
            api._pendingCollectionDeletes.delete(colID);
        }

        for (const [colID, rec] of api._pendingCollectionDeletes.entries()) {
            if (now - rec.ts > api._pendingTTLms) continue;

            for (const itemID of (ids || [])) {
                if (!rec.itemIDs.has(itemID)) continue;
                if (event === "trash") rec.trashedItems.add(itemID);
                else if (event === "delete") rec.deletedItems.add(itemID);
            }

            const trashedN = rec.trashedItems.size;
            const deletedN = rec.deletedItems.size;

            if (trashedN || deletedN) {
                api.info("COL",
                    `classify colID=${colID} => "Delete Collection and Items" (items trashed=${trashedN} deleted=${deletedN} of ${rec.itemIDs.size})`
                );
            }
        }
    },

    // ------------------------------------------------------------------
    // private: trash de UM attachment (reutilizável) + grava note
    // ------------------------------------------------------------------
    async _trashOneAttachment(api, attID) {
        const att = await Zotero.Items.getAsync(attID);
        if (!att || !_isAttachmentItem(att)) return;

        let path = "";
        try { path = await att.getFilePathAsync(); } catch { }
        path = _norm(path);

        api.info("ITEM", `trash(att) id=${attID} key=${att.key} path="${path}"`);

        if (!_looksAbsolute(path)) return;
        if (_isProbablyStored(path)) return;

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const trashName = Zotero.Prefs.get("extensions.fs-mirror.safeTrashDirName", true) || "_FSMirror_Trash";
        if (!rootDir) return;

        const rootN = _norm(rootDir);
        if (!path.startsWith(rootN)) return;

        const filename = _baseName(path) || `${att.key}.pdf`;
        const dst0 = _trashDestForLinked({ rootDir: rootN, trashName, attKey: att.key, filename });
        const dst = await _uniquePath(dst0);

        const parentItemID = att.parentItemID;
        if (parentItemID) {
            const st = await _readFSMirrorState(parentItemID);
            _stateUpsert(st, attID, {
                attKey: att.key,
                originalPath: path,
                trashedPath: dst,
                lastAction: "trash",
                ts: Date.now()
            });
            await _writeFSMirrorState(parentItemID, st);
        }

        api.info("ITEM", `ACTION: move linked -> trash "${path}" -> "${dst}"`);
        await _moveFile(path, dst);

        try {
            await _setLinkedAttachmentPath(att, dst);
            api.info("ITEM", `ACTION: updated attachment path -> "${dst}"`);
        } catch (e) {
            api.error("ITEM", `trash(att) path-update failed, rolling back: ${String(e)}`);
            try { await _moveFile(dst, path); } catch { }
            throw e;
        }
    },

    // ------------------------------------------------------------------
    // EVENT: trash
    // - attachment: move+update path
    // - parent item: varre attachments
    // ------------------------------------------------------------------
    async onItemTrash(api, id) {
        const item = await Zotero.Items.getAsync(id);
        if (!item) {
            api.info("ITEM", `trash id=${id} (missing)`);
            return;
        }

        const isAtt = _isAttachmentItem(item);
        const inTrash = _isInTrash(item);
        const key = item.key || "(no key)";

        let path = "";
        try { path = await item.getFilePathAsync(); } catch { }
        path = _norm(path);

        api.info("ITEM", `trash id=${id} key=${key} isAttachment=${!!isAtt} inTrash=${inTrash} path="${path}"`);

        if (isAtt) {
            try { await this._trashOneAttachment(api, id); }
            catch (e) { api.error("ITEM", `trash(att) failed id=${id}: ${String(e)}`); }
            return;
        }

        const attIDs = item.getAttachments?.() || [];
        if (!attIDs.length) return;

        api.info("ITEM", `trash(parent) id=${id} attachments=[${attIDs.join(",")}]`);

        for (const attID of attIDs) {
            try { await this._trashOneAttachment(api, attID); }
            catch (e) { api.error("ITEM", `trash(parent) failed attID=${attID}: ${String(e)}`); }
        }
    },

    // ------------------------------------------------------------------
    // EVENT: modify
    // Restore via NOTE:
    // - se attachment saiu do trash: restaura se estiver em LINKED_TRASH
    // - se parent saiu do trash: tenta restaurar attachments também
    // ------------------------------------------------------------------
    async onItemModify(api, id) {
        const item = await Zotero.Items.getAsync(id);
        if (!item) return;

        const inTrash = _isInTrash(item);
        if (inTrash) return; // ainda em trash

        // Caso A) attachment restaurado
        if (_isAttachmentItem(item)) {
            await this._restoreIfNeeded(api, item);
            return;
        }

        // Caso B) parent item restaurado -> varre attachments
        const attIDs = item.getAttachments?.() || [];
        if (!attIDs.length) return;

        api.info("ITEM", `modify(parent) id=${id} -> try restore attachments=[${attIDs.join(",")}]`);
        for (const attID of attIDs) {
            const att = await Zotero.Items.getAsync(attID);
            if (!att || !_isAttachmentItem(att)) continue;
            await this._restoreIfNeeded(api, att);
        }
    },

    async _restoreIfNeeded(api, att) {
        let curPath = "";
        try { curPath = await att.getFilePathAsync(); } catch { }
        curPath = _norm(curPath);

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const trashName = Zotero.Prefs.get("extensions.fs-mirror.safeTrashDirName", true) || "_FSMirror_Trash";
        const rootN = _norm(rootDir);

        if (!rootN) return;
        const linkedTrashPrefix = _norm(`${rootN}/${trashName}/LINKED_TRASH/`);

        // só restaura se ele ainda está apontando pro LINKED_TRASH
        if (!curPath.startsWith(linkedTrashPrefix)) return;

        const parentItemID = att.parentItemID;
        if (!parentItemID) return;

        const st = await _readFSMirrorState(parentItemID);
        const rec = st?.byAttachmentID?.[String(att.id)];
        if (!rec || !rec.originalPath || !rec.trashedPath) {
            api.warn("ITEM", `RESTORE: no note record for attID=${att.id} (skip)`);
            return;
        }

        const from = _norm(rec.trashedPath);
        const to0 = _norm(rec.originalPath);

        if (!(await _exists(from))) {
            api.warn("ITEM", `RESTORE: trashed file missing "${from}" (skip)`);
            return;
        }

        const to = await _uniquePath(to0);

        try {
            api.info("ITEM", `RESTORE: move back "${from}" -> "${to}"`);
            await _moveFile(from, to);
            await _setLinkedAttachmentPath(att, to);
            api.info("ITEM", `RESTORE: updated attachment path -> "${to}"`);

            // atualiza note (limpa trashedPath)
            _stateUpsert(st, att.id, { originalPath: to, trashedPath: null, lastAction: "restore", ts: Date.now() });
            await _writeFSMirrorState(parentItemID, st);
        } catch (e) {
            api.error("ITEM", `RESTORE failed attID=${att.id}: ${String(e)}`);
        }
    },

    // ------------------------------------------------------------------
    // EVENT: delete definitivo
    // (por enquanto: só log + TODO; você disse que resolve depois)
    // ------------------------------------------------------------------
    async onItemDelete(api, id) {
        api.info("ITEM", `delete id=${id} (no-op for now; will implement elegant final delete later)`);
    }
};