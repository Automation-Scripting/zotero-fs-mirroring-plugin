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
    const bytes = await IOUtils.read(src);
    await _ensureDir(_parentDir(dst));
    await IOUtils.write(dst, bytes);
}

async function _moveFile(src, dst) {
    // move real: copy + remove
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
    return dst; // fallback improvável
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

function _trashDestForLinked({ rootDir, trashName, attKey, filename }) {
    const base = _norm(rootDir);
    const tname = trashName || "_FSMirror_Trash";
    return _norm(`${base}/${tname}/LINKED_TRASH/${attKey}/${filename}`);
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

        // expira trackers
        for (const [colID, rec] of api._pendingCollectionDeletes.entries()) {
            if (now - rec.ts <= api._pendingTTLms) continue;

            if (rec.trashedItems.size === 0 && rec.deletedItems.size === 0) {
                api.info("COL",
                    `classify colID=${colID} => "Delete Collection (only)" (0 items trashed/deleted of ${rec.itemIDs.size})`
                );
            }
            api._pendingCollectionDeletes.delete(colID);
        }

        // marca itens afetados
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
    // cache (pra lidar com delete "missing")
    // ------------------------------------------------------------------
    _ensureCache(api) {
        if (!api._itemFSState) api._itemFSState = new Map(); // id -> { lastPath, trashedPath, attKey, ts }
        return api._itemFSState;
    },

    _putCache(api, id, data) {
        const m = this._ensureCache(api);
        m.set(Number(id), { ...(m.get(Number(id)) || {}), ...data, ts: Date.now() });
    },

    _getCache(api, id) {
        const m = this._ensureCache(api);
        return m.get(Number(id)) || null;
    },

    // ------------------------------------------------------------------
    // private: trash de UM attachment (reutilizável)
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

        // cache ANTES
        this._putCache(api, attID, { lastPath: path, trashedPath: dst, attKey: att.key });

        // move + update path (com rollback se update falhar)
        api.info("ITEM", `ACTION: move linked -> trash "${path}" -> "${dst}"`);
        await _moveFile(path, dst);

        try {
            await _setLinkedAttachmentPath(att, dst);
            api.info("ITEM", `ACTION: updated attachment path -> "${dst}"`);
        } catch (e) {
            api.error("ITEM", `trash(att) path-update failed, rolling back: ${String(e)}`);
            // rollback pra não deixar o Zotero apontando pro nada
            try { await _moveFile(dst, path); } catch { }
            throw e;
        }
    },

    // ------------------------------------------------------------------
    // EVENT: trash
    // - se for attachment: trash do arquivo + update path
    // - se for item pai: varre attachments e aplica em cada um
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

        // Caso 1: trash do próprio attachment
        if (isAtt) {
            try { await this._trashOneAttachment(api, id); }
            catch (e) { api.error("ITEM", `trash(att) failed id=${id}: ${String(e)}`); }
            return;
        }

        // Caso 2: trash do metadado (item pai)
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
    // Detecta restore: attachment saiu da lixeira (inTrash=false)
    // ------------------------------------------------------------------
    async onItemModify(api, id) {
        const item = await Zotero.Items.getAsync(id);
        if (!item || !_isAttachmentItem(item)) return;

        const inTrash = _isInTrash(item);
        if (inTrash) return; // ainda em trash, nada aqui

        const st = this._getCache(api, id);
        if (!st || !st.trashedPath || !st.lastPath) return;

        const from = _norm(st.trashedPath);
        const to0 = _norm(st.lastPath);

        if (!(await _exists(from))) {
            // limpa para evitar ficar preso
            this._putCache(api, id, { trashedPath: null });
            return;
        }

        const to = await _uniquePath(to0);

        try {
            api.info("ITEM", `RESTORE: move back "${from}" -> "${to}"`);
            await _moveFile(from, to);
            await _setLinkedAttachmentPath(item, to);
            api.info("ITEM", `RESTORE: updated attachment path -> "${to}"`);

            this._putCache(api, id, { lastPath: to, trashedPath: null });
        } catch (e) {
            api.error("ITEM", `restore failed id=${id}: ${String(e)}`);
        }
    },

    // ------------------------------------------------------------------
    // EVENT: delete definitivo
    // ------------------------------------------------------------------
    async onItemDelete(api, id) {
        let item = await Zotero.Items.getAsync(id);
        if (item) {
            const isAtt = _isAttachmentItem(item);
            let path = "";
            try { path = await item.getFilePathAsync(); } catch { }
            path = _norm(path);

            api.info("ITEM", `delete id=${id} isAttachment=${!!isAtt} path="${path}"`);

            // Só mexe em linked dentro do rootDir
            if (isAtt && _looksAbsolute(path) && !_isProbablyStored(path)) {
                const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
                const rootN = _norm(rootDir);
                if (rootN && path.startsWith(rootN)) {
                    try {
                        if (await _exists(path)) {
                            await IOUtils.remove(path);
                            api.info("ITEM", `DELETE: removed linked file "${path}"`);
                        }
                    } catch (e) {
                        api.warn("ITEM", `DELETE: could not remove "${path}": ${String(e)}`);
                    }
                }
            }
        } else {
            api.info("ITEM", `delete id=${id} (missing) -> will use cache if available`);
        }

        // fallback via cache (quando chega missing)
        const st = this._getCache(api, id);
        if (!st) return;

        const candidate = st.trashedPath || st.lastPath;
        if (!candidate) return;

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const rootN = _norm(rootDir);
        if (!rootN) return;

        if (!String(candidate).startsWith(rootN)) return;

        try {
            if (await _exists(candidate)) {
                await IOUtils.remove(_norm(candidate));
                api.info("ITEM", `DELETE(cache): removed "${candidate}"`);
            } else {
                api.info("ITEM", `DELETE(cache): file already missing "${candidate}"`);
            }
        } catch (e) {
            api.warn("ITEM", `DELETE(cache): failed "${candidate}": ${String(e)}`);
        } finally {
            this._ensureCache(api).delete(Number(id));
        }
    }
};