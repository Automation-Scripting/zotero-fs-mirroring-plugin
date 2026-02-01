// function/sanitize.js
//
// Sanitizer (collection-scoped):
// - Scans items in selected collection
// - For each item: PDF attachments
// - Classifies attachment as LINKED vs STORED
// - For STORED: COPY to plannedPath + create LINKED attachment (idempotent)
// - (Next step): archive+delete STORED attachment safely
//

// ------------------------------------------------------------
// Top-level "private" helpers (module scope)
// ------------------------------------------------------------

async function _debugGetAnnotationsRaw({ api, att }) {
    const res = {
        attID: att.id,
        attKey: att.key,
        via: {},
    };

    // A) att.getAnnotations()
    try {
        if (typeof att.getAnnotations === "function") {
            const r = att.getAnnotations();
            res.via.getAnnotations = {
                ok: true,
                type: _typeOf(r),
                isArray: Array.isArray(r),
                len: Array.isArray(r) ? r.length : null,
                peek: _peekArray(r),
                raw: _short(r),
            };
        } else {
            res.via.getAnnotations = { ok: false, reason: "no function" };
        }
    } catch (e) {
        res.via.getAnnotations = { ok: false, error: String(e) };
    }

    // B) Zotero.Items.getAnnotations(att.id)
    try {
        if (typeof Zotero.Items.getAnnotations === "function") {
            const r = await Zotero.Items.getAnnotations(att.id);
            res.via.Items_getAnnotations = {
                ok: true,
                type: _typeOf(r),
                isArray: Array.isArray(r),
                len: Array.isArray(r) ? r.length : null,
                peek: _peekArray(r),
                raw: _short(r),
            };
        } else {
            res.via.Items_getAnnotations = { ok: false, reason: "no function" };
        }
    } catch (e) {
        res.via.Items_getAnnotations = { ok: false, error: String(e) };
    }

    // C) Zotero.Items.getChildren(att.id)
    try {
        if (typeof Zotero.Items.getChildren === "function") {
            const r = await Zotero.Items.getChildren(att.id);
            res.via.Items_getChildren = {
                ok: true,
                type: _typeOf(r),
                isArray: Array.isArray(r),
                len: Array.isArray(r) ? r.length : null,
                peek: _peekArray(r),
                raw: _short(r),
            };
        } else {
            res.via.Items_getChildren = { ok: false, reason: "no function" };
        }
    } catch (e) {
        res.via.Items_getChildren = { ok: false, error: String(e) };
    }

    api.info("SAN", `DEBUG annotations raw: ${_short(res, 2000)}`);
    return res;
}

function _short(x, n = 220) {
    try {
        const s = typeof x === "string" ? x : JSON.stringify(x);
        if (!s) return String(x);
        return s.length > n ? s.slice(0, n) + "…(trunc)" : s;
    } catch {
        return String(x);
    }
}

function _typeOf(x) {
    if (x === null) return "null";
    if (Array.isArray(x)) return "array";
    return typeof x;
}

function _peekArray(arr, k = 5) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, k).map(v => {
        const t = _typeOf(v);
        if (t === "object") {
            const keys = Object.keys(v).slice(0, 8);
            return { t, hasId: "id" in v, id: v.id, keys };
        }
        return { t, v };
    });
}

function _norm(p) {
    return String(p || "").replace(/\/+/g, "/");
}

function _attachmentPath(att) {
    // tenta caminhos comuns
    return att.getFilePath?.() || att.getField?.("path") || "";
}

async function _hasLinkedAttachmentPointingTo({ parentItemID, plannedPath }) {
    const parent = await Zotero.Items.getAsync(parentItemID);
    if (!parent) return false;

    const attIDs = parent.getAttachments?.() || [];
    const target = _norm(plannedPath);

    for (const id of attIDs) {
        const a = await Zotero.Items.getAsync(id);
        if (!a) continue;

        let p = "";
        try { p = await a.getFilePathAsync?.(); } catch { }
        p = _norm(p || _attachmentPath(a));
        if (!p) continue;

        // match exato do destino
        if (p === target) return true;
    }
    return false;
}

function _isStoredPath(p) {
    const s = _norm(p);
    return s.includes("/storage/") && s.toLowerCase().endsWith(".pdf");
}

// Pega .../Zotero/storage/<KEY>/<file>.pdf  -> .../Zotero/storage/<KEY>
function _storageDirFromPDFPath(pdfPath) {
    const p = _norm(pdfPath);
    return p.replace(/\/[^\/]+\.pdf$/i, "");
}

async function _exists(p) {
    try { return await IOUtils.exists(p); } catch { return false; }
}

// Copia um diretório recursivamente usando IOUtils (Zotero 8)
async function _copyDirRecursive(srcDir, dstDir) {
    await IOUtils.makeDirectory(dstDir, { createAncestors: true });

    const entries = await IOUtils.getChildren(srcDir);
    for (const srcChild of entries) {
        const name = srcChild.split("/").pop();
        const dstChild = `${dstDir}/${name}`.replace(/\/+/g, "/");

        const st = await IOUtils.stat(srcChild);
        if (st.type === "directory") {
            await _copyDirRecursive(srcChild, dstChild);
        } else {
            const bytes = await IOUtils.read(srcChild);
            await IOUtils.write(dstChild, bytes);
        }
    }
}

// Guardrail: existe um LINKED apontando exatamente para plannedPath?
async function _hasLinkedToPlanned({ parentItem, plannedPath }) {
    const target = _norm(plannedPath);
    const attIDs = parentItem.getAttachments?.() || [];

    for (const id of attIDs) {
        const a = await Zotero.Items.getAsync(id);
        if (!a || !a.isAttachment()) continue;

        let p = "";
        try { p = await a.getFilePathAsync(); } catch { }
        p = _norm(p);

        if (!p) continue;
        if (!p.includes("/storage/") && p === target) return true;
    }
    return false;
}

function _trimSlash(s) {
    return _norm(s).replace(/\/+$/, "");
}

function _getBaseAttachmentPath() {
    // pref padrão do Zotero para Linked Attachment Base Directory
    // (normalmente aparece como extensions.zotero.baseAttachmentPath no config editor)
    return Zotero.Prefs.get("extensions.zotero.baseAttachmentPath", true) || "";
}

function _toZoteroLinkedPath(absPath) {
    const base = _trimSlash(_getBaseAttachmentPath());
    const p = _norm(absPath);

    // se estiver sob a base, armazena relativo como attachments:<relpath>
    if (base && p.startsWith(base + "/")) {
        const rel = p.slice(base.length + 1); // remove "base/"
        return `attachments:${rel}`;
    }

    // senão, absoluto mesmo
    return p;
}
// ------------------------------------------------------------
// Public module API
// ------------------------------------------------------------
function _getAnnotationItems(att) {
    try {
        if (typeof att.getAnnotations === "function") {
            const arr = att.getAnnotations() || [];
            // garante que são itens annotation
            return arr.filter(x => x && (x.isAnnotation?.() || x.itemType === "annotation"));
        }
    } catch { }
    return [];
}

async function _getChildAnnotationIDs(att) {
    // tenta APIs mais diretas, dependendo da versão/contexto
    try {
        if (typeof att.getAnnotations === "function") {
            return att.getAnnotations() || [];
        }
    } catch { }

    try {
        if (typeof Zotero.Items.getAnnotations === "function") {
            return await Zotero.Items.getAnnotations(att.id);
        }
    } catch { }

    // fallback: alguns builds expõem children
    try {
        if (typeof Zotero.Items.getChildren === "function") {
            const kids = await Zotero.Items.getChildren(att.id);
            // pode vir IDs ou itens; normaliza pra IDs
            return (kids || []).map(k => (typeof k === "number" ? k : k.id)).filter(Boolean);
        }
    } catch { }

    return [];
}

async function _cloneItemToNewParent({ oldItem, newParentID }) {
    // Estratégia mais resiliente: clona via JSON
    // (remove campos que não podem repetir e troca o parentItem)
    const data = oldItem.toJSON ? oldItem.toJSON() : null;
    if (!data) throw new Error("oldItem.toJSON() unavailable");

    // limpa identidade
    delete data.key;
    delete data.version;
    delete data.dateAdded;
    delete data.dateModified;

    // garante parent novo
    data.parentItem = newParentID;

    // cria item novo do mesmo tipo
    const ni = new Zotero.Item(oldItem.itemType);
    if (typeof ni.fromJSON === "function") {
        ni.fromJSON(data);
    } else {
        // fallback mínimo: copia campos básicos (bem menos completo)
        for (const [k, v] of Object.entries(data)) {
            try { ni.setField(k, v); } catch { }
        }
        ni.parentItemID = newParentID;
    }

    await ni.saveTx();
    return ni;
}

async function _transferAnnotations({ api, oldAtt, newAtt }) {
    const anns = _getAnnotationItems(oldAtt);

    api.info("SAN", `transfer annotations: oldAttKey=${oldAtt.key} -> newAttKey=${newAtt.key} count=${anns.length}`);
    if (!anns.length) return;

    for (const ann of anns) {
        try {
            const data = ann.toJSON ? ann.toJSON() : null;
            if (!data) throw new Error("annotation.toJSON unavailable");

            // limpa identidade
            delete data.key;
            delete data.version;
            delete data.dateAdded;
            delete data.dateModified;

            // IMPORTANTÍSSIMO:
            // no teu JSON, parentItem aparece como KEY do attachment (ex: "8ZARVMR2"),
            // então vamos manter isso consistente:
            data.parentItem = newAtt.key;

            const ni = new Zotero.Item("annotation");

            if (typeof ni.fromJSON === "function") {
                ni.fromJSON(data);
            } else {
                // fallback mínimo (raro precisar)
                ni.parentItemID = newAtt.id;
            }

            // redundância boa: garante parent por ID também
            ni.parentItemID = newAtt.id;

            await ni.saveTx();
        } catch (e) {
            api.error("SAN", `failed cloning annotation id=${ann.id} key=${ann.key}: ${String(e)}`);
            // continua; guardrail vai decidir se pode deletar
        }
    }

    // guardrail: confirma que o novo attachment "enxerga" annotations
    const after = _getAnnotationItems(newAtt);
    api.info("SAN", `transfer annotations done newAttKey=${newAtt.key} nowHas=${after.length}`);
}

var FS_Sanitize = {

    // --- collection recursion helpers (keep ONE copy) ---
    async _getChildCollections(collectionID) {
        if (typeof Zotero.Collections.getByParent === "function") {
            return Zotero.Collections.getByParent(collectionID) || [];
        }
        const all = Zotero.Collections.getAll?.() || [];
        return all.filter(c => c && c.parentID === collectionID);
    },

    async _getDescendantCollections(rootCollectionID) {
        const out = [];
        const q = [rootCollectionID];
        const seen = new Set([rootCollectionID]);

        while (q.length) {
            const curID = q.shift();
            const kids = await this._getChildCollections(curID);
            for (const c of kids) {
                if (!c || seen.has(c.id)) continue;
                seen.add(c.id);
                out.push(c);
                q.push(c.id);
            }
        }
        return out;
    },

    // -------------------------
    // ACTION 3: LINKED -> MOVE file to plannedPath + update attachment path
    // -------------------------
    async _moveLinkedAttachmentToPlanned({ api, att, linkedPath, plannedPath }) {
        const parentItemID = att.parentItemID;

        if (!parentItemID) {
            api.warn("SAN", `linked att id=${att.id} has no parentItemID; skipping`);
            return;
        }
        if (!linkedPath || !plannedPath) {
            api.warn("SAN", `missing linked/planned path; skipping (linked="${linkedPath}" planned="${plannedPath}")`);
            return;
        }

        const src = _norm(linkedPath);
        const dst = _norm(plannedPath);

        // idempotente: já está no destino
        if (src === dst) {
            api.info("SAN", `IDEMPOTENT: linked already at plannedPath "${dst}"`);
            return;
        }

        // guardrail: se já existe um LINKED apontando para dst, não duplica
        if (await _hasLinkedAttachmentPointingTo({ parentItemID, plannedPath: dst })) {
            api.warn("SAN", `guardrail: another attachment already links to plannedPath; NOT moving "${src}" -> "${dst}"`);
            return;
        }

        // existe no disco?
        if (!(await _exists(src))) {
            api.warn("SAN", `linked file missing on disk: "${src}" (skip move)`);
            return;
        }

        // move físico
        const dstDir = PathUtils.parent(dst);
        await IOUtils.makeDirectory(dstDir, { createAncestors: true });

        api.info("SAN", `ACTION: MOVE LINKED FILE "${src}" -> "${dst}"`);
        try {
            // se IOUtils.move existir no seu runtime, preferir:
            if (IOUtils.move) {
                await IOUtils.move(src, dst);
            } else {
                // fallback seguro: copy+remove
                await IOUtils.copy(src, dst);
                await IOUtils.remove(src);
            }
            api.info("SAN", `ACTION: MOVE OK -> "${dst}"`);
        } catch (e) {
            api.error("SAN", `MOVE failed: ${String(e)}`);
            return;
        }

        // atualiza o attachment (o próprio LINKED)
        const zotPath = _toZoteroLinkedPath(dst);

        try {
            // 1) Atualiza o campo certo do attachment
            if ("attachmentPath" in att) {
                att.attachmentPath = zotPath;   // ✅ o que o Zotero usa para linked paths
            } else if ("path" in att) {
                att.path = zotPath;             // fallback (em alguns contextos aparece assim)
            } else {
                throw new Error("attachment has no attachmentPath/path property");
            }

            await att.saveTx();

            // 2) Prova (resolved)
            let resolved = "";
            try { resolved = await att.getFilePathAsync(); } catch { }
            api.info("SAN", `ACTION: updated LINKED attKey=${att.key} attachmentPath="${zotPath}" resolved="${resolved || "(n/a)"}"`);
        } catch (e) {
            api.error("SAN", `update attachment path failed attKey=${att.key}: ${String(e)}`);
            api.warn("SAN", `  file was moved, but Zotero link may still point to old path.`);
        }
    },

    // -------------------------
    // helpers (object scope)
    // -------------------------
    _sanitizeName(name) {
        return (name || "Untitled")
            .replace(/[\/\\:\*\?"<>\|]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    },

    async _collectionChainByID(collectionID) {
        const chain = [];
        let cur = await Zotero.Collections.getAsync(collectionID);
        while (cur) {
            chain.push({ id: cur.id, key: cur.key, name: cur.name, parentID: cur.parentID });
            cur = cur.parentID ? await Zotero.Collections.getAsync(cur.parentID) : null;
        }
        return chain.reverse();
    },

    _collectionDesiredPath(rootDir, chain) {
        const segs = chain.map(x => `${this._sanitizeName(x.name)} [${x.key}]`);
        return [rootDir, ...segs].join("/").replace(/\/+/g, "/");
    },

    // Dentro de var FS_Sanitize = { ... }

    // garante extensão .pdf e evita nomes vazios
    _ensurePDFExt(name) {
        name = (name || "").trim();
        if (!name) name = "Untitled";
        return name.toLowerCase().endsWith(".pdf") ? name : (name + ".pdf");
    },

    // "Arquivo.pdf" -> "Arquivo (2).pdf", "Arquivo (3).pdf", ...
    async _resolveCollision(plannedFolder, filename) {
        filename = this._ensurePDFExt(filename);

        // tenta direto
        let candidate = `${plannedFolder}/${filename}`.replace(/\/+/g, "/");
        if (!(await IOUtils.exists(candidate))) return candidate;

        // separa base/ext
        const m = filename.match(/^(.*?)(\.[^.]+)$/);
        const base = (m?.[1] || filename).trim();
        const ext = (m?.[2] || ".pdf").trim();

        // começa em (2)
        for (let i = 2; i < 10_000; i++) {
            const f = `${base} (${i})${ext}`;
            candidate = `${plannedFolder}/${f}`.replace(/\/+/g, "/");
            if (!(await IOUtils.exists(candidate))) return candidate;
        }

        // se algo muito estranho acontecer
        throw new Error(`could not resolve filename collision for "${filename}" in "${plannedFolder}"`);
    },

    _plannedPDFName(parentItem /*, att */) {
        const title = this._sanitizeName(parentItem.getField("title"));
        const year = (parentItem.getField("date") || "").match(/\b(19|20)\d{2}\b/)?.[0] || "";
        const base = year ? `${title} - ${year}` : title;

        // SEM att.key
        return this._ensurePDFExt(base.replace(/\s+/g, " ").trim());
    },

    _classifyAttachmentPath(path) {
        if (!path) return { kind: "MISSING", reason: "no path" };
        const p = String(path).replace(/\\/g, "/");
        if (p.includes("/storage/")) return { kind: "STORED", reason: "path contains /storage/" };
        if (p.startsWith("/")) return { kind: "LINKED", reason: "absolute path" };
        return { kind: "UNKNOWN", reason: "non-absolute path" };
    },

    async _getSelectedCollection(window) {
        const zp = window.ZoteroPane;
        if (!zp) return null;

        if (typeof zp.getSelectedCollection === "function") return zp.getSelectedCollection();

        const cv = zp.getCollectionTreeRow?.();
        if (cv?.ref && cv.ref.isCollection?.()) return cv.ref;
        return null;
    },

    // -------------------------
    // ACTION 1: STORED -> COPY to plannedPath + create LINKED attachment
    // (keeps original STORED intact)
    // -------------------------
    async _copyAndAddLinkedAttachment({ api, att, storedPath, plannedPath, plannedPathCanonical = null }) {
        const parentItemID = att.parentItemID;

        if (!parentItemID) {
            api.warn("SAN", `attachment id=${att.id} has no parentItemID; skipping`);
            return;
        }
        if (!storedPath || !plannedPath) {
            api.warn("SAN", `missing stored/planned path; skipping (stored="${storedPath}" planned="${plannedPath}")`);
            return;
        }

        const dst = _norm(plannedPath);
        const dstCan = plannedPathCanonical ? _norm(plannedPathCanonical) : null;

        // ------------------------------------------------------------
        // Guardrail forte: se já existe LINKED -> CANÔNICO, não faz nada
        // (isso é o que evita o "(2)" quando está tudo certo)
        // ------------------------------------------------------------
        if (dstCan) {
            if (await _hasLinkedAttachmentPointingTo({ parentItemID, plannedPath: dstCan })) {
                api.info("SAN", `IDEMPOTENT: already linked -> canonical "${dstCan}" (skip copy+create)`);
                return;
            }
        }

        // Guardrail normal: se já existe LINKED -> dst (o que foi escolhido), não faz nada
        if (await _hasLinkedAttachmentPointingTo({ parentItemID, plannedPath: dst })) {
            api.info("SAN", `IDEMPOTENT: already linked -> "${dst}" (skip copy+create)`);
            return;
        }

        // ------------------------------------------------------------
        // 1) COPY físico (idempotente)
        // ------------------------------------------------------------
        const dstExists = await IOUtils.exists(dst);
        if (dstExists) {
            api.info("SAN", `IDEMPOTENT: dst already exists (skip copy) "${dst}"`);
        } else {
            const parentDir = PathUtils.parent(dst);
            await IOUtils.makeDirectory(parentDir, { createAncestors: true });

            api.info("SAN", `ACTION: COPY "${storedPath}" -> "${dst}"`);
            await IOUtils.copy(storedPath, dst);
            api.info("SAN", `ACTION: COPY OK -> "${dst}"`);
        }

        // Re-checa para evitar duplicata se algo apareceu no meio
        if (dstCan) {
            if (await _hasLinkedAttachmentPointingTo({ parentItemID, plannedPath: dstCan })) {
                api.info("SAN", `IDEMPOTENT: link to canonical appeared after copy (skip create) "${dstCan}"`);
                return;
            }
        }
        if (await _hasLinkedAttachmentPointingTo({ parentItemID, plannedPath: dst })) {
            api.info("SAN", `IDEMPOTENT: link appeared after copy (skip create) "${dst}"`);
            return;
        }

        // ------------------------------------------------------------
        // 2) Criar attachment LINKED
        // ------------------------------------------------------------
        const oldTitle = att.getField?.("title") || "PDF";
        const linkedTitle = /\(linked\)$/i.test(oldTitle) ? oldTitle : `${oldTitle} (linked)`;

        api.info("SAN", `ACTION: create LINKED attachment title="${linkedTitle}" -> "${dst}"`);

        const newAttachment = await Zotero.Attachments.linkFromFile({
            file: dst,
            parentItemID,
            title: linkedTitle
        });

        const newAttID = newAttachment?.id || newAttachment;
        const newAtt = await Zotero.Items.getAsync(newAttID);

        api.info("SAN", `ACTION: LINKED created attID=${newAtt?.id || newAttID} title="${linkedTitle}"`);

        // 3) Prova final
        const parent = await Zotero.Items.getAsync(parentItemID);
        const childIDs = parent?.getAttachments?.() || [];
        api.info("SAN", `PARENT attachments now: [${childIDs.join(", ")}]`);

        return newAtt;
    },

    // -------------------------
    // ACTION 2: Archive + HARD delete STORED attachment
    // (copies storageDir to root/_FSMirror_Trash and then eraseTx)
    // -------------------------
    async _archiveAndDeleteStoredPDF({ api, parentItem, storedAtt, plannedPath }) {
        if (!parentItem || !storedAtt) return;

        const ct = storedAtt.attachmentContentType || storedAtt.getField?.("contentType") || "";
        if (ct !== "application/pdf") {
            api.warn("SAN", `skip delete: not a PDF attKey=${storedAtt.key}`);
            return;
        }

        let storedPDFPath = "";
        try { storedPDFPath = await storedAtt.getFilePathAsync(); } catch { }
        storedPDFPath = _norm(storedPDFPath);

        if (!_isStoredPath(storedPDFPath)) {
            api.warn("SAN", `skip delete: not STORED path attKey=${storedAtt.key} path="${storedPDFPath}"`);
            return;
        }

        // Guardrail: só deleta se já existir LINKED apontando para plannedPath
        const hasLinked = await _hasLinkedToPlanned({ parentItem, plannedPath });
        if (!hasLinked) {
            api.warn("SAN", `guardrail: no LINKED->plannedPath, NOT deleting stored attKey=${storedAtt.key}`);
            api.warn("SAN", `  plannedPath="${plannedPath}"`);
            return;
        }

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const trashName = Zotero.Prefs.get("extensions.fs-mirror.safeTrashDirName", true) || "_FSMirror_Trash";
        if (!rootDir) {
            api.warn("SAN", `guardrail: rootDir not set, NOT deleting stored attKey=${storedAtt.key}`);
            return;
        }

        const storageDir = _storageDirFromPDFPath(storedPDFPath);
        const archiveDir = `${_norm(rootDir)}/${trashName}/STORED_DELETED/${storedAtt.key}`.replace(/\/+/g, "/");

        api.info("SAN", `DELETE plan attKey=${storedAtt.key}`);
        api.info("SAN", `  storedPDFPath="${storedPDFPath}"`);
        api.info("SAN", `  storageDir="${storageDir}"`);
        api.info("SAN", `  archiveDir="${archiveDir}"`);

        if (!(await _exists(storageDir))) {
            api.warn("SAN", `storageDir missing on disk, will still remove Zotero record attKey=${storedAtt.key}`);
        } else {
            try {
                await _copyDirRecursive(storageDir, archiveDir);
                api.info("SAN", `archived storageDir -> "${archiveDir}"`);
            } catch (e) {
                api.error("SAN", `archive failed, ABORT delete attKey=${storedAtt.key}: ${String(e)}`);
                return;
            }
        }

        // Remove attachment do Zotero
        try {
            await storedAtt.eraseTx();
            api.info("SAN", `deleted Zotero attachment record attKey=${storedAtt.key}`);
        } catch (e) {
            api.error("SAN", `eraseTx failed attKey=${storedAtt.key}: ${String(e)}`);
            return;
        }

        // Se ainda sobrou dir no disco, remove
        try {
            if (await _exists(storageDir)) {
                await IOUtils.remove(storageDir, { recursive: true });
                api.info("SAN", `removed original storageDir="${storageDir}"`);
            }
        } catch (e) {
            api.warn("SAN", `could not remove original storageDir (maybe already gone): ${String(e)}`);
        }
    },

    // -------------------------
    // MAIN: scan selected collection
    // -------------------------
    async scanSelectedCollection({ api, window } = {}) {
        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const col = await this._getSelectedCollection(window);

        if (!col) {
            api.error("SAN", "no selected collection (scan aborted)");
            return;
        }

        if (!rootDir) {
            api.error("SAN", "rootDir not set (scan aborted)");
            return;
        }

        // -------------------------
        // Build recursive collection list
        // -------------------------
        const descendants = await this._getDescendantCollections(col.id);
        const collections = [col, ...descendants];

        api.info("SAN", `scan start (recursive) rootCol id=${col.id} key=${col.key} name="${col.name}"`);
        api.info("SAN", `  collections in scope: ${collections.length}`);
        api.info("SAN", `  rootDir="${rootDir}"`);

        // -------------------------
        // PASS 1: collect candidates per attachment
        // attID -> { attID, attKey, itemID, parentItemID, kind, srcPath, plannedName, candidates:Set(plannedFolder) }
        // -------------------------
        const attPlan = new Map();

        for (const curCol of collections) {
            const chain = await this._collectionChainByID(curCol.id);
            const plannedFolder = this._collectionDesiredPath(rootDir, chain);

            let itemIDs = [];
            try { itemIDs = curCol.getChildItems(true); }
            catch { itemIDs = await curCol.getChildItemsAsync(true); }

            itemIDs = [...new Set(itemIDs)];

            api.info("SAN", `  collect: col="${curCol.name}" key=${curCol.key} items=${itemIDs.length}`);

            for (const id of itemIDs) {
                const item = await Zotero.Items.getAsync(id);
                if (!item) continue;
                if (item.isAttachment() || item.isNote() || item.isAnnotation?.()) continue;

                const attIDs = item.getAttachments?.() || [];
                for (const attID of attIDs) {
                    const att = await Zotero.Items.getAsync(attID);
                    if (!att || !att.isAttachment()) continue;

                    const ct = att.attachmentContentType || att.getField?.("contentType") || "";
                    if (ct !== "application/pdf") continue;

                    let path = "";
                    try { path = await att.getFilePathAsync(); } catch { path = ""; }

                    const cls = this._classifyAttachmentPath(path);
                    const plannedName = this._plannedPDFName(item, att);

                    let rec = attPlan.get(attID);
                    if (!rec) {
                        rec = {
                            attID,
                            attKey: att.key,
                            itemID: item.id,
                            parentItemID: att.parentItemID,
                            kind: cls.kind,
                            srcPath: path,
                            plannedName,
                            candidates: new Set(),
                        };
                        attPlan.set(attID, rec);
                    }

                    rec.candidates.add(_norm(plannedFolder));
                }
            }
        }

        api.info("SAN", `PASS1 done: pdfAttachmentsFound=${attPlan.size}`);

        // -------------------------
        // PASS 2: pick a single winner destination per attachment and execute once
        // Winner policy: lexicographically smallest plannedFolder (stable, deterministic)
        // -------------------------
        let moved = 0, copied = 0, skipped = 0;

        for (const rec of attPlan.values()) {
            const candidates = [...rec.candidates].sort();
            const plannedFolderWin = candidates[0];

            const plannedPathCanonical = _norm(`${plannedFolderWin}/${rec.plannedName}`);

            const att = await Zotero.Items.getAsync(rec.attID);
            const item = await Zotero.Items.getAsync(rec.itemID);

            api.info("SAN", `---- attID=${rec.attID} key=${rec.attKey} kind=${rec.kind}`);
            api.info("SAN", `  winnerFolder="${plannedFolderWin}"`);
            api.info("SAN", `  plannedPathCanonical="${plannedPathCanonical}"`);

            // Refresh current resolved path (it may have changed since PASS 1)
            let curPath = "";
            try { curPath = await att.getFilePathAsync(); } catch { curPath = ""; }
            curPath = _norm(curPath || "");

            // -------------------------
            // LINKED
            // -------------------------
            if (rec.kind === "LINKED") {
                if (!curPath) {
                    api.warn("SAN", `  skip LINKED: missing current path`);
                    skipped++;
                    continue;
                }

                // Idempotent: already at canonical
                if (_norm(curPath) === plannedPathCanonical) {
                    api.info("SAN", `  IDEMPOTENT: already at canonical`);
                    skipped++;
                    continue;
                }

                // collision only if canonical is occupied
                let plannedPath = plannedPathCanonical;
                if (await _exists(plannedPathCanonical)) {
                    plannedPath = await this._resolveCollision(plannedFolderWin, rec.plannedName);
                    api.warn("SAN", `  collision: canonical exists, using "${plannedPath}"`);
                }

                // if plannedPath ends up equal to src, stop
                if (_norm(plannedPath) === _norm(curPath)) {
                    api.info("SAN", `  IDEMPOTENT: src equals chosen dst`);
                    skipped++;
                    continue;
                }

                await this._moveLinkedAttachmentToPlanned({
                    api,
                    att,
                    linkedPath: curPath,
                    plannedPath
                });

                moved++;
                continue;
            }

            // -------------------------
            // STORED
            // -------------------------
            if (rec.kind === "STORED") {
                if (!curPath) {
                    api.warn("SAN", `  skip STORED: missing current path`);
                    skipped++;
                    continue;
                }

                // Strong guardrail: if there's already a LINKED to canonical, do nothing
                if (rec.parentItemID && await _hasLinkedAttachmentPointingTo({ parentItemID: rec.parentItemID, plannedPath: plannedPathCanonical })) {
                    api.info("SAN", `  IDEMPOTENT: already linked -> canonical (skip STORED migration)`);
                    skipped++;
                    continue;
                }

                let plannedPath = plannedPathCanonical;
                if (await _exists(plannedPathCanonical)) {
                    plannedPath = await this._resolveCollision(plannedFolderWin, rec.plannedName);
                    api.warn("SAN", `  collision: canonical exists, using "${plannedPath}"`);
                }

                newAtt = await this._copyAndAddLinkedAttachment({
                    api,
                    att,
                    storedPath: curPath,
                    plannedPath,
                    plannedPathCanonical
                });

                // DEBUG: inspeciona o que o Zotero retorna como "annotations" do attachment STORED
                await _debugGetAnnotationsRaw({ api, att });

                // ✅ transfere anotações do STORED(att) para o LINKED(newAtt)
                if (newAtt) {
                    await _transferAnnotations({ api, oldAtt: att, newAtt });
                } else {
                    api.warn("SAN", "newAtt missing; cannot transfer annotations");
                }

                api.info("SAN", `AFTER transfer: newAtt annotations=${_getAnnotationItems(newAtt).length}`);

                // verifica se newAtt recebeu as annotations
                const oldAnn = await _getAnnotationItems(att);
                const newAnn = newAtt ? await _getAnnotationItems(newAtt) : [];
                if (oldAnn.length && (!newAnn || newAnn.length < oldAnn.length)) {
                    api.error("SAN", `guardrail: annotations not fully transferred; ABORT delete storedAttKey=${att.key}`);
                    continue; // pula deleção
                }

                // ✅ só agora pode arquivar+apagar
                await this._archiveAndDeleteStoredPDF({ api, parentItem: item, storedAtt: att, plannedPath });

                copied++;
                continue;
            }

            // -------------------------
            // other / missing
            // -------------------------
            api.warn("SAN", `  skip: kind=${rec.kind}`);
            skipped++;
        }

        api.info("SAN", `scan done (recursive) moved=${moved} copied=${copied} skipped=${skipped} total=${attPlan.size}`);
    }
};