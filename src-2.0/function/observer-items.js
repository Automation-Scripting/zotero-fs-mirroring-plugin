// function/observer-items.js

var IOUtils = globalThis.IOUtils;
var PathUtils = globalThis.PathUtils;

// ------------------------------
// helpers (top-level, fora do objeto)
// ------------------------------
function _norm(p) { return String(p || "").replace(/\/+/g, "/"); }

function _isProbablyStored(p) {
    const s = _norm(p);
    return s.includes("/storage/"); // não mexer em storage do Zotero aqui
}

function _looksAbsolute(p) {
    const s = _norm(p);
    return s.startsWith("/");
}

function _baseName(p) {
    const s = _norm(p);
    return s.split("/").pop() || "";
}

function _parentDir(p) {
    return PathUtils.parent(_norm(p));
}

async function _exists(p) {
    try { return await IOUtils.exists(_norm(p)); } catch { return false; }
}

async function _ensureDir(p) {
    return IOUtils.makeDirectory(_norm(p), { createAncestors: true });
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

async function _copyFile(src, dst) {
    const bytes = await IOUtils.read(_norm(src));
    await _ensureDir(_parentDir(dst));
    await IOUtils.write(_norm(dst), bytes);
}

async function _moveFile(src, dst) {
    // move "real": copy + remove
    await _copyFile(src, dst);
    try { await IOUtils.remove(_norm(src)); } catch { }
}

// Atualiza o attachment LINKED pra apontar para outro arquivo
async function _setLinkedAttachmentPath(att, newPath) {
    // Para linked attachments, o caminho fica no field "path"
    att.setField("path", _norm(newPath));
    await att.saveTx();
}

function _trashDestForLinked({ rootDir, trashName, attKey, filename }) {
    const base = _norm(rootDir);
    const tname = trashName || "_FSMirror_Trash";
    return _norm(`${base}/${tname}/LINKED_TRASH/${attKey}/${filename}`);
}

// ------------------------------
// FS_ItemsObserver
// ------------------------------
var FS_ItemsObserver = {

    // ------------------------------------------------------------------
    // Seu classificador original (mantém)
    // ------------------------------------------------------------------
    async onTrashOrDelete(api, event, ids) {
        const now = Date.now();
        if (!api._pendingCollectionDeletes || api._pendingCollectionDeletes.size === 0) return;

        for (const [colID, rec] of api._pendingCollectionDeletes.entries()) {
            if (now - rec.ts <= api._pendingTTLms) continue;

            if (rec.trashedItems.size === 0 && rec.deletedItems.size === 0) {
                api.info(
                    "COL",
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
                api.info(
                    "COL",
                    `classify colID=${colID} => "Delete Collection and Items" (items trashed=${trashedN} deleted=${deletedN} of ${rec.itemIDs.size})`
                );
            }
        }
    },

    // ------------------------------------------------------------------
    // cache (pra lidar com delete "missing" e restore)
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
    // PRIVATE: trash de UM attachment linked (sob rootDir)
    // ------------------------------------------------------------------
    async _trashOneAttachment(api, attID) {
        const att = await Zotero.Items.getAsync(attID);
        if (!att || !_isAttachmentItem(att)) return;

        let path = "";
        try { path = await att.getFilePathAsync(); } catch { }
        path = _norm(path);

        api.info("ITEM", `trash(att) id=${attID} key=${att.key} path="${path}"`);

        // Só mexer em linked absoluto, fora de /storage/
        if (!_looksAbsolute(path)) return;
        if (_isProbablyStored(path)) return;

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const trashName = Zotero.Prefs.get("extensions.fs-mirror.safeTrashDirName", true) || "_FSMirror_Trash";
        if (!rootDir) return;

        // Guardrail: só opera dentro do rootDir
        if (!path.startsWith(_norm(rootDir))) return;

        const filename = _baseName(path) || `${att.key}.pdf`;
        const dst0 = _trashDestForLinked({ rootDir, trashName, attKey: att.key, filename });
        const dst = await _uniquePath(dst0);

        // cache por attID
        this._putCache(api, attID, { lastPath: path, trashedPath: dst, attKey: att.key });

        api.info("ITEM", `ACTION: move linked -> trash "${path}" -> "${dst}"`);
        await _moveFile(path, dst);

        api.info("ITEM", `TRASH: before saveTx inTrash=${item.isInTrash?.()} path="${path}" -> "${dst}"`);

        item.setField("path", dst);
        await item.saveTx();

        api.info("ITEM", `TRASH: after saveTx inTrash=${item.isInTrash?.()} path="${dst}"`);

        // await _setLinkedAttachmentPath(att, dst);
        // api.info("ITEM", `ACTION: updated attachment path -> "${dst}"`);
    },

    // ------------------------------------------------------------------
    // PRIVATE: restore de UM attachment (quando sai do trash)
    // ------------------------------------------------------------------
    async _restoreOneAttachment(api, attID, attItem) {
        const st = this._getCache(api, attID);
        if (!st || !st.trashedPath || !st.lastPath) return;

        const from = _norm(st.trashedPath);
        const to0 = _norm(st.lastPath);

        // Se o arquivo não existe no trash, limpa trashedPath e sai
        if (!(await _exists(from))) {
            this._putCache(api, attID, { trashedPath: null });
            return;
        }

        // Se o destino original já existe, aplica regra de colisão
        const to = await _uniquePath(to0);

        api.info("ITEM", `RESTORE: move back "${from}" -> "${to}"`);
        await _moveFile(from, to);

        await _setLinkedAttachmentPath(attItem, to);
        api.info("ITEM", `RESTORE: updated attachment path -> "${to}"`);

        this._putCache(api, attID, { lastPath: to, trashedPath: null });
    },

    // ------------------------------------------------------------------
    // AÇÃO: trash
    // - Se for attachment: trash só ele
    // - Se for metadado (item pai): trash de TODOS attachments linked (sob rootDir)
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

        // Caso 1) trash de attachment
        if (isAtt) {
            try {
                await this._trashOneAttachment(api, id);
            } catch (e) {
                api.error("ITEM", `trash(att) failed id=${id}: ${String(e)}`);
            }
            return;
        }

        // Caso 2) trash de metadado (item pai)
        // -> varre attachments e trasha os linked sob rootDir
        const attIDs = item.getAttachments?.() || [];
        if (!attIDs.length) return;

        api.info("ITEM", `trash(parent) id=${id} attachments=[${attIDs.join(",")}]`);

        for (const attID of atts) {
            await FS_ItemsObserver.onItemTrash(api, attID);
        }
    },

    // ------------------------------------------------------------------
    // AÇÃO: modify  (detecta restore: inTrash=false)
    // Observação: o Zotero faz restore mudando flags e disparando modify.
    // ------------------------------------------------------------------
    async onItemModify(api, id) {
        const item = await Zotero.Items.getAsync(id);
        if (!item) return;

        const isAtt = _isAttachmentItem(item);
        if (!isAtt) return;

        const inTrash = _isInTrash(item);

        // Se está em trash, não faz nada aqui (onItemTrash já cuidou)
        if (inTrash) return;

        // Restore: estava em trash, agora saiu
        try {
            await this._restoreOneAttachment(api, id, item);
        } catch (e) {
            api.error("ITEM", `restore failed id=${id}: ${String(e)}`);
        }
    },

    // ------------------------------------------------------------------
    // AÇÃO: delete definitivo
    // - Se item ainda existe e é attachment linked sob rootDir: remove arquivo
    // - Se item vem missing: usa cache (trashedPath/lastPath)
    // ------------------------------------------------------------------
    async onItemDelete(api, id) {
        let item = await Zotero.Items.getAsync(id);

        if (item) {
            const isAtt = _isAttachmentItem(item);

            let path = "";
            try { path = await item.getFilePathAsync(); } catch { }
            path = _norm(path);

            api.info("ITEM", `delete id=${id} isAttachment=${!!isAtt} path="${path}"`);

            // Só deletar do FS se for linked sob rootDir e não storage
            if (isAtt && _looksAbsolute(path) && !_isProbablyStored(path)) {
                const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
                if (rootDir && path.startsWith(_norm(rootDir))) {
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

        // missing (ou mesmo exists): tenta cache
        const st = this._getCache(api, id);
        if (!st) return;

        const candidate = st.trashedPath || st.lastPath;
        if (!candidate) return;

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        if (!rootDir) return;

        // Guardrail: só apaga dentro do rootDir
        if (!_norm(candidate).startsWith(_norm(rootDir))) return;

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