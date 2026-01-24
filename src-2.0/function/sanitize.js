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

// ------------------------------------------------------------
// Public module API
// ------------------------------------------------------------

var FS_Sanitize = {
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
    async _copyAndAddLinkedAttachment({ api, att, storedPath, plannedPath }) {
        const parentItemID = att.parentItemID;

        if (!parentItemID) {
            api.warn("SAN", `attachment id=${att.id} has no parentItemID; skipping`);
            return;
        }
        if (!storedPath || !plannedPath) {
            api.warn("SAN", `missing stored/planned path; skipping (stored="${storedPath}" planned="${plannedPath}")`);
            return;
        }

        // Guard rail: já existe link para plannedPath
        if (await _hasLinkedAttachmentPointingTo({ parentItemID, plannedPath })) {
            api.info("SAN", `IDEMPOTENT: already linked -> "${plannedPath}" (skip copy+create)`);
            return;
        }

        // 1) COPY físico
        const dstExists = await IOUtils.exists(plannedPath);
        if (dstExists) {
            api.info("SAN", `IDEMPOTENT: dst already exists (skip copy) "${plannedPath}"`);
        } else {
            const parentDir = PathUtils.parent(plannedPath);
            await IOUtils.makeDirectory(parentDir, { createAncestors: true });

            api.info("SAN", `ACTION: COPY "${storedPath}" -> "${plannedPath}"`);
            await IOUtils.copy(storedPath, plannedPath);
            api.info("SAN", `ACTION: COPY OK -> "${plannedPath}"`);
        }

        // Re-checa para evitar duplicata se algo apareceu no meio
        if (await _hasLinkedAttachmentPointingTo({ parentItemID, plannedPath })) {
            api.info("SAN", `IDEMPOTENT: link appeared after copy (skip create) "${plannedPath}"`);
            return;
        }

        // 2) Criar attachment LINKED
        const oldTitle = att.getField?.("title") || "PDF";
        const linkedTitle = /\(linked\)$/i.test(oldTitle) ? oldTitle : `${oldTitle} (linked)`;

        api.info("SAN", `ACTION: create LINKED attachment title="${linkedTitle}" -> "${plannedPath}"`);

        const newAttachment = await Zotero.Attachments.linkFromFile({
            file: plannedPath,
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

        api.info("SAN", `scan collection start id=${col.id} key=${col.key} name="${col.name}" rootDir="${rootDir || "(not set)"}"`);

        const chain = await this._collectionChainByID(col.id);
        const chainStr = chain.map(x => `${x.name}(${x.key})`).join(" > ");
        const plannedFolder = rootDir ? this._collectionDesiredPath(rootDir, chain) : null;

        api.info("SAN", `  col chain: ${chainStr}`);
        api.info("SAN", `  col folder (planned): "${plannedFolder || "(no rootDir)"}"`);

        let itemIDs = [];
        try {
            itemIDs = col.getChildItems(true);
        } catch (e) {
            try {
                itemIDs = await col.getChildItemsAsync(true);
            } catch (e2) {
                api.error("SAN", `cannot get items for collection: ${String(e2)}`);
                return;
            }
        }

        itemIDs = [...new Set(itemIDs)];
        api.info("SAN", `  items in scope: ${itemIDs.length}`);

        let scannedItems = 0;
        let pdfCount = 0;

        for (const id of itemIDs) {
            const item = await Zotero.Items.getAsync(id);
            if (!item) continue;

            if (item.isAttachment() || item.isNote() || item.isAnnotation?.()) continue;

            scannedItems++;

            const title = this._sanitizeName(item.getField("title"));
            api.info("SAN", `item id=${id} key=${item.key} title="${title}"`);

            const attIDs = item.getAttachments ? item.getAttachments() : [];
            if (!attIDs.length) continue;

            for (const attID of attIDs) {
                const att = await Zotero.Items.getAsync(attID);
                if (!att || !att.isAttachment()) continue;

                const ct = att.attachmentContentType || att.getField?.("contentType") || "";
                if (ct !== "application/pdf") continue;

                pdfCount++;

                let path = "";
                try { path = await att.getFilePathAsync(); } catch { path = ""; }

                const cls = this._classifyAttachmentPath(path);

                const plannedName = this._plannedPDFName(item, att);
                let plannedPath = null;
                if (plannedFolder) {
                    plannedPath = await this._resolveCollision(plannedFolder, plannedName);
                }

                api.info("SAN", `  pdf att id=${attID} key=${att.key} kind=${cls.kind} (${cls.reason})`);
                api.info("SAN", `    zoteroPath="${path || "(missing)"}"`);
                api.info("SAN", `    plannedPath="${plannedPath || "(no planned folder)"}"`);

                if (cls.kind === "STORED") {
                    api.warn("SAN", `    candidate: STORED -> ACTION copy + add LINKED attachment`);

                    if (!plannedPath) {
                        api.error("SAN", "    ACTION skipped: plannedPath is null (rootDir not set?)");
                    } else if (!path) {
                        api.error("SAN", "    ACTION skipped: stored zoteroPath missing");
                    } else {
                        await this._copyAndAddLinkedAttachment({
                            api,
                            att,
                            storedPath: path,
                            plannedPath
                        });

                        // >>> Quando você decidir ativar o hard-delete, você chama aqui:
                        await this._archiveAndDeleteStoredPDF({ api, parentItem: item, storedAtt: att, plannedPath });
                    }
                } else if (cls.kind === "LINKED") {
                    const underRoot = rootDir && path && String(path).startsWith(rootDir);
                    api.info("SAN", `    check: linkedUnderRoot=${!!underRoot}`);
                } else if (cls.kind === "MISSING") {
                    api.warn("SAN", `    candidate: missing file`);
                } else {
                    api.warn("SAN", `    candidate: UNKNOWN path format`);
                }
            }
        }

        api.info("SAN", `scan collection done itemsScanned=${scannedItems} pdfAttachments=${pdfCount}`);
    }
};