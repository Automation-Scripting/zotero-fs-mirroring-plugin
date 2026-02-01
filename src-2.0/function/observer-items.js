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

async function _removeFileIfExists(p) {
    try {
        p = _norm(p);
        if (await _exists(p)) await IOUtils.remove(p);
    } catch { }
}

async function _removeDirIfEmpty(dir) {
    try {
        dir = _norm(dir);
        // Se não existe, nada
        if (!(await _exists(dir))) return;

        // IOUtils.getChildren() existe em builds recentes; fallback: tenta listar via PathUtils?
        if (typeof IOUtils.getChildren !== "function") return;

        const children = await IOUtils.getChildren(dir);
        if (children && children.length === 0) {
            await IOUtils.remove(dir); // remove dir vazio

            // tenta remover o parent se também ficar vazio (limpa "attKey/")
            const parent = _parentDir(dir);
            if (parent && parent !== dir) {
                const parentChildren = await IOUtils.getChildren(parent);
                if (parentChildren && parentChildren.length === 0) {
                    await IOUtils.remove(parent);
                }
            }
        }
    } catch { }
}

// --------------------
// Observer
// --------------------
var FS_ItemsObserver = {

    _ensureIgnore(api) {
        if (!api._fsMirrorIgnoreDeleteIDs) api._fsMirrorIgnoreDeleteIDs = new Set();
        return api._fsMirrorIgnoreDeleteIDs;
    },
    _markIgnoreDelete(api, id) {
        this._ensureIgnore(api).add(Number(id));
    },
    _shouldIgnoreDelete(api, id) {
        return this._ensureIgnore(api).has(Number(id));
    },
    _clearIgnoreDelete(api, id) {
        this._ensureIgnore(api).delete(Number(id));
    },

    async _restoreAttachmentFromNote(api, attItem) {
        if (!attItem || !_isAttachmentItem(attItem)) return false;

        const parentItemID = attItem.parentItemID;
        if (!parentItemID) return false;

        const entry = await this._popRestoreEntry(api, {
            parentItemID,
            attID: attItem.id,
            attKey: attItem.key
        });

        if (!entry || !entry.to || !entry.from) return false;

        const from = _norm(entry.to);   // onde está agora (FSMirror trash)
        const to0 = _norm(entry.from); // destino original

        if (!(await _exists(from))) {
            api.warn("ITEM", `RESTORE(note): missing "${from}" (skip)`);
            return false;
        }

        const to = await _uniquePath(to0);

        try {
            api.info("ITEM", `RESTORE(note): move back "${from}" -> "${to}"`);
            await _moveFile(from, to);
            await _setLinkedAttachmentPath(attItem, to);
            api.info("ITEM", `RESTORE(note): updated attachment path -> "${to}"`);

            this._putCache(api, attItem.id, { lastPath: to, trashedPath: null, attKey: attItem.key });
            return true;
        } catch (e) {
            api.error("ITEM", `RESTORE(note) failed attID=${attItem.id}: ${String(e)}`);
            // opcional: re-inserir entry no note se quiser (por enquanto não)
            return false;
        }
    },

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

        if (arr.length === 0) {
            try {
                // ✅ marca pra ignorar o delete event desse noteID
                this._markIgnoreDelete(api, note.id);

                // ✅ melhor: deferir a deleção pra fora do notifier callstack
                setTimeout(async () => {
                    try {
                        if (typeof note.eraseTx === "function") await note.eraseTx();
                        else if (typeof Zotero.Items.eraseTx === "function") await Zotero.Items.eraseTx(note.id);
                        else await Zotero.DB.queryAsync("DELETE FROM items WHERE itemID=?", [note.id]);

                        api.info("NOTE", `restore-map note deleted (empty) parent=${parentItemID} noteID=${note.id}`);
                    } catch (e) {
                        api.warn("NOTE", `restore-map note delete failed: ${String(e)}`);
                    } finally {
                        // limpa ignore (pra não crescer infinito)
                        this._clearIgnoreDelete(api, note.id);
                    }
                }, 0);

            } catch (e) {
                await this._writeRestoreMapToNote(note, []);
                api.warn("NOTE", `restore-map note delete scheduling failed; kept empty []: ${String(e)}`);
            }
        }

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

        const originalPath = path; // ✅ captura ANTES de qualquer mutação

        api.info("ITEM", `trash(att) id=${attID} key=${att.key} path="${path}"`);

        if (!_looksAbsolute(path)) return;
        if (_isProbablyStored(path)) return;

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const trashName = Zotero.Prefs.get("extensions.fs-mirror.safeTrashDirName", true) || "_FSMirror_Trash";
        if (!rootDir) return;

        const rootN = _norm(rootDir);
        // if (!originalPath.startsWith(rootN)) return;

        const filename = _baseName(originalPath) || `${att.key}.pdf`;
        const dst0 = _trashDestForLinked({ rootDir: rootN, trashName, attKey: att.key, filename });
        const dst = await _uniquePath(dst0);

        // ✅ cache ANTES, com o caminho ORIGINAL
        this._putCache(api, attID, { lastPath: originalPath, trashedPath: dst, attKey: att.key });

        // move + update path (com rollback se update falhar)
        api.info("ITEM", `ACTION: move linked -> trash "${originalPath}" -> "${dst}"`);
        await _moveFile(originalPath, dst);

        try {
            await _setLinkedAttachmentPath(att, dst);
            api.info("ITEM", `ACTION: updated attachment path -> "${dst}"`);

            // ✅ guarda rota de volta no NOTE do item pai (from = original, to = trash)
            const parentItemID = att.parentItemID;
            if (parentItemID) {
                await this._upsertRestoreEntry(api, {
                    parentItemID,
                    attID: att.id,
                    attKey: att.key,
                    from: originalPath, // ✅
                    to: dst             // ✅
                });
            }
        } catch (e) {
            api.error("ITEM", `trash(att) path-update failed, rolling back: ${String(e)}`);
            // ✅ rollback: volta para o caminho ORIGINAL
            try { await _moveFile(dst, originalPath); } catch { }
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

    async _restoreOneFromNote(api, att) {
        if (!att || !_isAttachmentItem(att)) return false;
        if (_isInTrash(att)) return false;

        const parentItemID = att.parentItemID;
        if (!parentItemID) return false;

        const entry = await this._popRestoreEntry(api, {
            parentItemID,
            attID: att.id,
            attKey: att.key
        });

        if (!entry || !entry.to || !entry.from) return false;

        const from = _norm(entry.to);   // trash
        const to0 = _norm(entry.from); // original

        if (!(await _exists(from))) {
            api.warn("ITEM", `RESTORE(note): trash file missing "${from}"`);
            return true; // já não existe; consideramos resolvido pra não travar
        }

        const to = await _uniquePath(to0);

        try {
            api.info("ITEM", `RESTORE(note): move back "${from}" -> "${to}"`);
            await _moveFile(from, to);
            await _setLinkedAttachmentPath(att, to);
            api.info("ITEM", `RESTORE(note): updated attachment path -> "${to}"`);

            // limpa lixo: remove dir do attKey se vazio
            await _removeDirIfEmpty(_parentDir(from)); // .../LINKED_TRASH/<attKey> (arquivo dentro)
            // sincroniza cache (opcional)
            this._putCache(api, att.id, { lastPath: to, trashedPath: null, attKey: att.key });

            return true;
        } catch (e) {
            api.error("ITEM", `RESTORE(note) failed attID=${att.id}: ${String(e)}`);
            return false;
        }
    },

    // ------------------------------------------------------------------
    // EVENT: modify
    // Detecta restore: attachment saiu da lixeira (inTrash=false)
    // ------------------------------------------------------------------
    async onItemModify(api, id) {
        const item = await Zotero.Items.getAsync(id);
        if (!item) return;

        // Se ainda está no trash, não é restore
        if (_isInTrash(item)) return;

        // -----------------------------
        // Caso A) modify do ATTACHMENT
        // -----------------------------
        if (_isAttachmentItem(item)) {
            // 1) restore via NOTE (preferencial)
            const ok = await this._restoreOneFromNote(api, item);
            if (ok) return;

            // 2) fallback cache
            const st = this._getCache(api, id);
            if (!st || !st.trashedPath || !st.lastPath) return;

            const from = _norm(st.trashedPath);
            const to0 = _norm(st.lastPath);

            if (!(await _exists(from))) {
                this._putCache(api, id, { trashedPath: null });
                return;
            }

            const to = await _uniquePath(to0);

            try {
                api.info("ITEM", `RESTORE(cache): move back "${from}" -> "${to}"`);
                await _moveFile(from, to);
                await _setLinkedAttachmentPath(item, to);
                api.info("ITEM", `RESTORE(cache): updated attachment path -> "${to}"`);

                await _removeDirIfEmpty(_parentDir(from));
                this._putCache(api, id, { lastPath: to, trashedPath: null });
            } catch (e) {
                api.error("ITEM", `restore(cache) failed id=${id}: ${String(e)}`);
            }
            return;
        }

        // -----------------------------
        // Caso B) modify do PARENT (seu caso real do restore pela UI)
        // -----------------------------
        const attIDs = item.getAttachments?.() || [];
        if (!attIDs.length) return;

        api.info("ITEM", `RESTORE(parent-modify): id=${id} attachments=[${attIDs.join(",")}]`);

        for (const attID of attIDs) {
            const att = await Zotero.Items.getAsync(attID);
            if (!att || !_isAttachmentItem(att)) continue;
            // tenta restaurar cada um pelo note
            await this._restoreOneFromNote(api, att);
        }
    },

    // ------------------------------------------------------------------
    // EVENT: delete definitivo
    // ------------------------------------------------------------------
    async onItemDelete(api, id) {
        // ✅ 0) ignore marcado
        if (this._shouldIgnoreDelete(api, id)) {
            api.info("ITEM", `delete id=${id} ignored (marked)`);
            this._clearIgnoreDelete(api, id);
            return;
        }

        // ✅ 1) SEM DB LOOKUP: delete é pós-commit, item pode não existir
        const st = this._getCache(api, id);
        if (!st) {
            api.debug("ITEM", `delete id=${id} (no cache)`);
            return;
        }

        // ✅ 2) Só processa deleção de attachment PDF LINKED
        // Você precisa ter gravado isso no cache no add/modify:
        // st.kind: "ATTACHMENT" | "NOTE" | "ANNOTATION" | ...
        // st.isPDF: boolean
        // st.linkMode: "LINKED" | "STORED" | ...
        if (st.kind !== "ATTACHMENT" || !st.isPDF || st.linkMode !== "LINKED") {
            api.debug("ITEM", `delete id=${id} ignored (cached kind=${st.kind} pdf=${!!st.isPDF} linkMode=${st.linkMode})`);
            this._ensureCache(api).delete(Number(id));
            return;
        }

        const candidate = st.lastPath;
        if (!candidate) {
            this._ensureCache(api).delete(Number(id));
            return;
        }

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const rootN = _norm(rootDir);
        if (!rootN || !String(candidate).startsWith(rootN)) {
            this._ensureCache(api).delete(Number(id));
            return;
        }

        try {
            if (await _exists(candidate)) {
                await IOUtils.remove(_norm(candidate));
                api.info("ITEM", `DELETE: removed linked file "${candidate}"`);
            } else {
                api.info("ITEM", `DELETE: file already missing "${candidate}"`);
            }
        } catch (e) {
            api.warn("ITEM", `DELETE: failed "${candidate}": ${String(e)}`);
        } finally {
            this._ensureCache(api).delete(Number(id));
        }
    }
};