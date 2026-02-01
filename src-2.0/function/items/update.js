// function/items/update.js

// depende de: _norm, _uniquePath, _exists, _moveFile, _removeDirIfEmpty
// depende de: _isAttachmentItem, _isInTrash
// depende de: FS_ItemsCache (cache.js)

async function _setLinkedAttachmentPath(att, newPath) {
    const p = _norm(newPath);

    // 1) Tenta APIs "boas" se existirem nesse build
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
        // cai pro fallback abaixo
    }

    // 2) Fallback robusto: atualiza direto a tabela de attachments
    //    (é aqui que o path de LINKED attachment vive)
    await Zotero.DB.queryAsync(
        "UPDATE itemAttachments SET path=? WHERE itemID=?",
        [p, att.id]
    );

    // Recarrega o item na memória (se disponível)
    try {
        if (typeof att.reload === "function") await att.reload();
    } catch { }
}

// -------------------------------
// NOTE-based restore map (parent item)
// -------------------------------
var FS_ItemsRestoreMap = {
    _noteHeader: "[FSMirror] linked-trash-map v1",

    async _getOrCreateRestoreNote(api, parentItemID) {
        const parent = await Zotero.Items.getAsync(parentItemID);
        if (!parent) return null;

        // procura note filha com nosso header
        const noteIDs = parent.getNotes?.() || [];
        for (const nid of noteIDs) {
            const n = await Zotero.Items.getAsync(nid);
            if (!n || n.isNote?.() !== true) continue;

            const txt = n.getNote?.() || "";
            if (String(txt).startsWith(this._noteHeader)) return n;
        }

        // cria note
        const note = new Zotero.Item("note");
        note.parentItemID = parentItemID;
        note.setNote(`${this._noteHeader}\n[]`);
        await note.saveTx();

        api.info("NOTE", `created restore-map note for parentItemID=${parentItemID} noteID=${note.id}`);
        return note;
    },

    async _readRestoreMapFromNote(noteItem) {
        const raw = String(noteItem.getNote?.() || "");
        const lines = raw.split("\n");
        if (!lines.length) return [];

        const json = lines.slice(1).join("\n").trim();
        if (!json) return [];

        try {
            const arr = JSON.parse(json);
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    },

    async _writeRestoreMapToNote(noteItem, arr) {
        const body = JSON.stringify(arr, null, 2);
        noteItem.setNote(`${this._noteHeader}\n${body}`);
        await noteItem.saveTx();
    },

    async upsert(api, { parentItemID, attID, attKey, from, to }) {
        const note = await this._getOrCreateRestoreNote(api, parentItemID);
        if (!note) return;

        const arr = await this._readRestoreMapFromNote(note);
        const ts = new Date().toISOString();

        const idx = arr.findIndex(x => Number(x.attID) === Number(attID) || (x.attKey && x.attKey === attKey));
        const entry = { attID: Number(attID), attKey: String(attKey || ""), from: _norm(from), to: _norm(to), ts };

        if (idx >= 0) arr[idx] = entry;
        else arr.push(entry);

        await this._writeRestoreMapToNote(note, arr);
        api.info("NOTE", `restore-map upsert parent=${parentItemID} attID=${attID} from="${entry.from}" to="${entry.to}"`);
    },

    async pop(api, { parentItemID, attID, attKey }) {
        const parent = await Zotero.Items.getAsync(parentItemID);
        if (!parent) return null;

        const noteIDs = parent.getNotes?.() || [];
        let note = null;

        for (const nid of noteIDs) {
            const n = await Zotero.Items.getAsync(nid);
            if (!n || n.isNote?.() !== true) continue;
            const txt = n.getNote?.() || "";
            if (String(txt).startsWith(this._noteHeader)) { note = n; break; }
        }
        if (!note) return null;

        const arr = await this._readRestoreMapFromNote(note);
        const idx = arr.findIndex(x => Number(x.attID) === Number(attID) || (attKey && x.attKey === attKey));
        if (idx < 0) return null;

        const entry = arr[idx];
        arr.splice(idx, 1);

        if (arr.length === 0) {
            try {
                FS_ItemsCache._markIgnoreDelete(api, note.id);

                setTimeout(async () => {
                    try {
                        if (typeof note.eraseTx === "function") await note.eraseTx();
                        else if (typeof Zotero.Items.eraseTx === "function") await Zotero.Items.eraseTx(note.id);
                        else await Zotero.DB.queryAsync("DELETE FROM items WHERE itemID=?", [note.id]);

                        api.info("NOTE", `restore-map note deleted (empty) parent=${parentItemID} noteID=${note.id}`);
                    } catch (e) {
                        api.warn("NOTE", `restore-map note delete failed: ${String(e)}`);
                    } finally {
                        FS_ItemsCache._clearIgnoreDelete(api, note.id);
                    }
                }, 0);

            } catch (e) {
                await this._writeRestoreMapToNote(note, []);
                api.warn("NOTE", `restore-map note delete scheduling failed; kept empty []: ${String(e)}`);
            }
        }

        api.info("NOTE", `restore-map pop parent=${parentItemID} attID=${attID}`);
        return entry;
    }
};

// -------------------------------
// restore de um attachment via note
// -------------------------------
async function _restoreOneFromNote(api, att) {
    if (!att || !_isAttachmentItem(att)) return false;
    if (_isInTrash(att)) return false;

    const parentItemID = att.parentItemID;
    if (!parentItemID) return false;

    const entry = await FS_ItemsRestoreMap.pop(api, {
        parentItemID,
        attID: att.id,
        attKey: att.key
    });

    if (!entry || !entry.to || !entry.from) return false;

    const from = _norm(entry.to);   // trash
    const to0 = _norm(entry.from);  // original

    if (!(await _exists(from))) {
        api.warn("ITEM", `RESTORE(note): trash file missing "${from}"`);
        return true;
    }

    const to = await _uniquePath(to0);

    try {
        api.info("ITEM", `RESTORE(note): move back "${from}" -> "${to}"`);
        await _moveFile(from, to);
        await _setLinkedAttachmentPath(att, to);
        api.info("ITEM", `RESTORE(note): updated attachment path -> "${to}"`);

        await _removeDirIfEmpty(_parentDir(from));
        FS_ItemsCache._putCache(api, att.id, { lastPath: to, trashedPath: null, attKey: att.key });

        return true;
    } catch (e) {
        api.error("ITEM", `RESTORE(note) failed attID=${att.id}: ${String(e)}`);
        return false;
    }
}


// -------------------------------
// trash de UM attachment (reutilizável)
// -------------------------------
async function _trashOneAttachment(api, attID) {
    const att = await Zotero.Items.getAsync(attID);
    if (!att || !_isAttachmentItem(att)) return;

    await FS_ItemsCache._cacheMetaFromItem(api, att);

    let path = "";
    try { path = await att.getFilePathAsync(); } catch { }
    path = _norm(path);

    const originalPath = path; // ✅ captura ANTES de qualquer mutação

    api.info("ITEM", `trash(att) id=${attID} key=${att.key} path="${path}"`);

    if (!_looksAbsolute(path)) return;
    if (_isProbablyStored(path)) return;

    const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
    const trashName = Zotero.Prefs.get("extensions.fs-mirror.safeTrashDirName", true) || "_FSMirror_Trash";
    if (!rootDir) return;

    const rootN = _norm(rootDir);

    const filename = _baseName(originalPath) || `${att.key}.pdf`;
    const dst0 = _trashDestForLinked({ rootDir: rootN, trashName, attKey: att.key, filename });
    const dst = await _uniquePath(dst0);

    // ✅ cache ANTES, com o caminho ORIGINAL
    FS_ItemsCache._putCache(api, attID, { lastPath: originalPath, trashedPath: dst, attKey: att.key });

    api.info("ITEM", `ACTION: move linked -> trash "${originalPath}" -> "${dst}"`);
    await _moveFile(originalPath, dst);

    try {
        await _setLinkedAttachmentPath(att, dst);
        api.info("ITEM", `ACTION: updated attachment path -> "${dst}"`);

        const parentItemID = att.parentItemID;
        if (parentItemID) {
            await FS_ItemsRestoreMap.upsert(api, {
                parentItemID,
                attID: att.id,
                attKey: att.key,
                from: originalPath,
                to: dst
            });
        }
    } catch (e) {
        api.error("ITEM", `trash(att) path-update failed, rolling back: ${String(e)}`);
        try { await _moveFile(dst, originalPath); } catch { }
        throw e;
    }
}

// -------------------------------
// EVENT: trash
// -------------------------------
async function FS_Items_onItemTrash(api, id) {
    const item = await Zotero.Items.getAsync(id);
    if (!item) {
        api.info("ITEM", `trash id=${id} (missing)`);
        return;
    }

    await FS_ItemsCache._cacheMetaFromItem(api, item);

    const isAtt = _isAttachmentItem(item);
    const inTrash = _isInTrash(item);
    const key = item.key || "(no key)";

    let path = "";
    try { path = await item.getFilePathAsync(); } catch { }
    path = _norm(path);

    api.info("ITEM", `trash id=${id} key=${key} isAttachment=${!!isAtt} inTrash=${inTrash} path="${path}"`);

    if (isAtt) {
        try { await _trashOneAttachment(api, id); }
        catch (e) { api.error("ITEM", `trash(att) failed id=${id}: ${String(e)}`); }
        return;
    }

    const attIDs = item.getAttachments?.() || [];
    if (!attIDs.length) return;

    api.info("ITEM", `trash(parent) id=${id} attachments=[${attIDs.join(",")}]`);

    // ✅ cachear o ATTACHMENT, não o parent
    for (const attID of attIDs) {
        const att = await Zotero.Items.getAsync(attID);
        if (!att || !_isAttachmentItem(att)) continue;

        await FS_ItemsCache._cacheMetaFromItem(api, att);
        try { await _trashOneAttachment(api, attID); }
        catch (e) { api.error("ITEM", `trash(parent) failed attID=${attID}: ${String(e)}`); }
    }
}

// -------------------------------
// EVENT: modify
// -------------------------------
async function FS_Items_onItemModify(api, id) {
    const item = await Zotero.Items.getAsync(id);
    if (!item) return;

    await FS_ItemsCache._cacheMetaFromItem(api, item);

    if (_isInTrash(item)) return;

    // Caso A) modify do ATTACHMENT
    if (_isAttachmentItem(item)) {
        // ✅ cache do próprio item (att), não "att" inexistente
        await FS_ItemsCache._cacheMetaFromItem(api, item);

        const ok = await _restoreOneFromNote(api, item);
        if (ok) return;

        const st = FS_ItemsCache._getCache(api, id);
        if (!st || !st.trashedPath || !st.lastPath) return;

        const from = _norm(st.trashedPath);
        const to0 = _norm(st.lastPath);

        if (!(await _exists(from))) {
            FS_ItemsCache._putCache(api, id, { trashedPath: null });
            return;
        }

        const to = await _uniquePath(to0);

        try {
            api.info("ITEM", `RESTORE(cache): move back "${from}" -> "${to}"`);
            await _moveFile(from, to);
            await _setLinkedAttachmentPath(item, to);
            api.info("ITEM", `RESTORE(cache): updated attachment path -> "${to}"`);

            await _removeDirIfEmpty(_parentDir(from));
            FS_ItemsCache._putCache(api, id, { lastPath: to, trashedPath: null });
        } catch (e) {
            api.error("ITEM", `restore(cache) failed id=${id}: ${String(e)}`);
        }
        return;
    }

    // Caso B) modify do PARENT (restore pela UI)
    const attIDs = item.getAttachments?.() || [];
    if (!attIDs.length) return;

    api.info("ITEM", `RESTORE(parent-modify): id=${id} attachments=[${attIDs.join(",")}]`);

    for (const attID of attIDs) {
        const att = await Zotero.Items.getAsync(attID);
        if (!att || !_isAttachmentItem(att)) continue;

        await FS_ItemsCache._cacheMetaFromItem(api, att);
        await _restoreOneFromNote(api, att);
    }
}