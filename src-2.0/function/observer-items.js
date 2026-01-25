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

    // -------------------------------
    // NOTE-based restore map (parent item)
    // -------------------------------
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

        // Esperado:
        // line0: header
        // rest: JSON (array)
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

    async _upsertRestoreEntry(api, { parentItemID, attID, attKey, from, to }) {
        const note = await this._getOrCreateRestoreNote(api, parentItemID);
        if (!note) return;

        const arr = await this._readRestoreMapFromNote(note);
        const ts = new Date().toISOString();

        // chave primária: attID (mais robusto); fallback por attKey
        const idx = arr.findIndex(x => Number(x.attID) === Number(attID) || (x.attKey && x.attKey === attKey));

        const entry = { attID: Number(attID), attKey: String(attKey || ""), from: _norm(from), to: _norm(to), ts };

        if (idx >= 0) arr[idx] = entry;
        else arr.push(entry);

        await this._writeRestoreMapToNote(note, arr);
        api.info("NOTE", `restore-map upsert parent=${parentItemID} attID=${attID} from="${entry.from}" to="${entry.to}"`);
    },

    async _popRestoreEntry(api, { parentItemID, attID, attKey }) {
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

        // se esvaziou, mantém a note (ou apaga se você quiser — por enquanto mantém)
        await this._writeRestoreMapToNote(note, arr);

        api.info("NOTE", `restore-map pop parent=${parentItemID} attID=${attID}`);
        return entry;
    },

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

            // guarda rota de volta no NOTE do item pai
            const parentItemID = att.parentItemID;
            if (parentItemID) {
                await this._upsertRestoreEntry(api, {
                    parentItemID,
                    attID: att.id,
                    attKey: att.key,
                    from: path,
                    to: dst
                });
            }
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

        // 1) tenta restore via NOTE do parent (persistente e determinístico)
        const parentItemID = item.parentItemID;
        if (parentItemID) {
            const entry = await this._popRestoreEntry(api, {
                parentItemID,
                attID: id,
                attKey: item.key
            });

            if (entry && entry.to && entry.from) {
                const from = _norm(entry.to);   // onde está (trash)
                const to0 = _norm(entry.from); // destino original

                if (await _exists(from)) {
                    const to = await _uniquePath(to0);

                    try {
                        api.info("ITEM", `RESTORE(note): move back "${from}" -> "${to}"`);
                        await _moveFile(from, to);
                        await _setLinkedAttachmentPath(item, to);
                        api.info("ITEM", `RESTORE(note): updated attachment path -> "${to}"`);

                        // sincroniza cache também (opcional, mas ajuda)
                        this._putCache(api, id, { lastPath: to, trashedPath: null, attKey: item.key });
                        return;
                    } catch (e) {
                        api.error("ITEM", `RESTORE(note) failed id=${id}: ${String(e)}`);
                        // se falhou, você pode re-inserir o entry na NOTE (opcional)
                    }
                } else {
                    api.warn("ITEM", `RESTORE(note): trash file missing "${from}" (nothing to move)`);
                }
            }
        }

        // 2) fallback: se não tinha NOTE (ou falhou), cai no cache (como já está)
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