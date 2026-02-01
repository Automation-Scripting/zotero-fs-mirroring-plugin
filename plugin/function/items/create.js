// function/items/create.js
// Depende de: FS_CollectionsRead (collections/read.js)
// Depende de: _norm, _exists, _ensureDir, _copyFile, _uniquePath (common/io.js)
// Depende de: _isProbablyStored (common/path.js)
// Depende de: _setLinkedAttachmentPath (trash.js)  // <- reutilizamos
// Depende de: PathUtils, IOUtils

// ============================================================
// Helpers: PDF + naming
// ============================================================

function _isPDF(att) {
    const ct = att.attachmentContentType || att.getField?.("contentType") || "";
    return ct === "application/pdf";
}

function _sanitizeName(name) {
    return (name || "Untitled")
        .replace(/[\/\\:\*\?"<>\|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function _ensurePDFExt(name) {
    name = (name || "").trim();
    if (!name) name = "Untitled";
    return name.toLowerCase().endsWith(".pdf") ? name : (name + ".pdf");
}

function _plannedPDFName(parentItem) {
    const title = _sanitizeName(parentItem.getField?.("title") || "Untitled");
    const year = (parentItem.getField?.("date") || "")
        .match(/\b(19|20)\d{2}\b/)?.[0] || "";
    const base = year ? `${title} - ${year}` : title;
    return _ensurePDFExt(base.replace(/\s+/g, " ").trim());
}

async function _hasLinkedAttachmentPointingTo({ parentItem, plannedPath }) {
    const attIDs = parentItem.getAttachments?.() || [];
    const target = _norm(plannedPath);

    for (const id of attIDs) {
        const a = await Zotero.Items.getAsync(id);
        if (!a || !a.isAttachment?.()) continue;

        let p = "";
        try { p = await a.getFilePathAsync?.(); } catch { }
        p = _norm(p || a.getFilePath?.() || a.attachmentPath || "");
        if (!p) continue;

        // só LINKED (não storage)
        if (!_isProbablyStored(p) && p === target) return true;
    }
    return false;
}

// ============================================================
// Helpers: annotations transfer (igual sanitize)
// ============================================================

function _getAnnotationItems(att) {
    try {
        if (typeof att.getAnnotations === "function") {
            const arr = att.getAnnotations() || [];
            return arr.filter(x => x && (x.isAnnotation?.() || x.itemType === "annotation"));
        }
    } catch { }
    return [];
}

async function _cloneItemToNewParent({ oldItem, newParentID, newParentKey }) {
    const data = oldItem.toJSON ? oldItem.toJSON() : null;
    if (!data) throw new Error("oldItem.toJSON unavailable");

    delete data.key;
    delete data.version;
    delete data.dateAdded;
    delete data.dateModified;

    // parent no JSON costuma ser KEY do attachment; garantimos ambos
    if (newParentKey) data.parentItem = newParentKey;

    const ni = new Zotero.Item(oldItem.itemType);

    if (typeof ni.fromJSON === "function") {
        ni.fromJSON(data);
    } else {
        ni.parentItemID = newParentID; // fallback mínimo
    }

    ni.parentItemID = newParentID;
    await ni.saveTx();
    return ni;
}

async function _transferAnnotations({ api, oldAtt, newAtt }) {
    const anns = _getAnnotationItems(oldAtt);
    api.info("ITEM", `create: transfer annotations old=${oldAtt.key} -> new=${newAtt.key} count=${anns.length}`);
    if (!anns.length) return;

    for (const ann of anns) {
        try {
            await _cloneItemToNewParent({
                oldItem: ann,
                newParentID: newAtt.id,
                newParentKey: newAtt.key
            });
        } catch (e) {
            api.error("ITEM", `create: clone annotation failed annKey=${ann.key}: ${String(e)}`);
        }
    }

    const after = _getAnnotationItems(newAtt);
    api.info("ITEM", `create: annotations now new=${newAtt.key} has=${after.length}`);
}

// ============================================================
// Helpers: STORED archive+delete (igual sanitize)
// ============================================================

function _storageDirFromPDFPath(pdfPath) {
    const p = _norm(pdfPath);
    return p.replace(/\/[^\/]+\.pdf$/i, "");
}

async function _archiveAndDeleteStoredPDF({ api, storedAtt, storedPDFPath }) {
    const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
    const trashName = Zotero.Prefs.get("extensions.fs-mirror.safeTrashDirName", true) || "_FSMirror_Trash";
    if (!rootDir) {
        api.warn("ITEM", `create: rootDir not set -> skip deleting STORED attKey=${storedAtt.key}`);
        return;
    }

    const storageDir = _storageDirFromPDFPath(storedPDFPath);
    const archiveDir = _norm(`${rootDir}/${trashName}/STORED_DELETED/${storedAtt.key}`);

    // arquiva diretório inteiro (best-effort)
    try {
        if (await _exists(storageDir)) {
            await IOUtils.makeDirectory(archiveDir, { createAncestors: true });

            const stack = [storageDir];
            while (stack.length) {
                const cur = stack.pop();
                const rel = cur.slice(storageDir.length).replace(/^\/+/, "");
                const outDir = _norm(`${archiveDir}/${rel}`);

                await IOUtils.makeDirectory(outDir, { createAncestors: true });

                const kids = await IOUtils.getChildren(cur);
                for (const p of kids) {
                    const st = await IOUtils.stat(p);
                    if (st.type === "directory") stack.push(p);
                    else {
                        const name = PathUtils.filename(p);
                        const dst = _norm(`${outDir}/${name}`);
                        const bytes = await IOUtils.read(p);
                        await IOUtils.write(dst, bytes);
                    }
                }
            }

            api.info("ITEM", `create: archived storageDir -> "${archiveDir}"`);
        }
    } catch (e) {
        api.error("ITEM", `create: archive failed, abort delete STORED: ${String(e)}`);
        return;
    }

    // deleta attachment STORED no Zotero
    try {
        await storedAtt.eraseTx();
        api.info("ITEM", `create: erased STORED attachment record attKey=${storedAtt.key}`);
    } catch (e) {
        api.error("ITEM", `create: eraseTx failed attKey=${storedAtt.key}: ${String(e)}`);
        return;
    }

    // remove storageDir físico (best-effort)
    try {
        if (await _exists(storageDir)) {
            await IOUtils.remove(storageDir, { recursive: true });
            api.info("ITEM", `create: removed storageDir="${storageDir}"`);
        }
    } catch (e) {
        api.warn("ITEM", `create: could not remove storageDir: ${String(e)}`);
    }
}

// ============================================================
// Helpers: escolher destino pela(s) collection(s) do parent item
// ============================================================

async function _winnerPlannedFolderForParentItem(api, parentItem) {
    const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
    if (!rootDir) return null;

    const colIDs = parentItem.getCollections?.() || [];
    if (!colIDs.length) return null;

    const candidates = [];

    for (const cid of colIDs) {
        const col = await Zotero.Collections.getAsync(cid);
        if (!col) continue;

        const chain = await FS_CollectionsRead.chain(col);
        const desired = _norm(FS_CollectionsRead.desiredPath(rootDir, chain));
        candidates.push(desired);
    }

    if (!candidates.length) return null;
    candidates.sort();              // determinístico (igual sanitize)
    return candidates[0];
}

// ============================================================
// CREATE: worker principal (o seu onAdd atual)
// ============================================================

async function _copyAndLinkFromStored({ api, parentItem, storedAtt, storedPDFPath, plannedAbsPath }) {
    const parentItemID = parentItem.id;
    const dst = _norm(plannedAbsPath);

    // 1) COPY físico (idempotente por destino)
    await _ensureDir(PathUtils.parent(dst));
    if (!(await _exists(dst))) {
        api.info("ITEM", `create: COPY "${storedPDFPath}" -> "${dst}"`);
        await _copyFile(storedPDFPath, dst);
    } else {
        api.info("ITEM", `create: dst exists, skip COPY "${dst}"`);
    }

    // 2) criar LINKED attachment
    const oldTitle = storedAtt.getField?.("title") || "PDF";
    const linkedTitle = /\(linked\)$/i.test(oldTitle) ? oldTitle : `${oldTitle} (linked)`;

    api.info("ITEM", `create: linkFromFile title="${linkedTitle}" -> "${dst}"`);
    const newAttachment = await Zotero.Attachments.linkFromFile({
        file: dst,
        parentItemID,
        title: linkedTitle
    });

    const newAttID = newAttachment?.id || newAttachment;
    const newAtt = await Zotero.Items.getAsync(newAttID);

    // normaliza o caminho usando o helper que você já padronizou
    await _setLinkedAttachmentPath(newAtt, dst);

    return newAtt;
}

// ============================================================
// Readiness + debounce scheduler
// ============================================================

// attID -> { firstSeen, tries, lastReason, timerID|null }
const _pending = new Map();

async function _isAttachmentReady(api, att) {
    if (!att || !att.isAttachment?.()) return { ok: false, why: "not_attachment" };
    if (!_isPDF(att)) return { ok: false, why: "not_pdf" };
    if (!att.parentItemID) return { ok: false, why: "no_parent" };

    // path resolvido precisa existir e ser STORED (porque create só migra stored)
    let p = "";
    try { p = await att.getFilePathAsync?.(); } catch { }
    p = _norm(p || "");
    if (!p) return { ok: false, why: "no_path_yet" };
    if (!_isProbablyStored(p)) return { ok: false, why: "not_stored_anymore" };

    // parent precisa estar “assentado” (título minimamente válido)
    const parent = await Zotero.Items.getAsync(att.parentItemID);
    if (!parent) return { ok: false, why: "parent_missing" };

    const title = (parent.getField?.("title") || "").trim();
    if (!title || title === "Untitled") return { ok: false, why: "parent_title_not_ready" };

    return { ok: true, why: "ready", storedPath: p, parent };
}

function _schedule(api, attID, reason, delayMs = 350) {
    const now = Date.now();
    let st = _pending.get(attID);
    if (!st) {
        st = { firstSeen: now, tries: 0, lastReason: reason, timerID: null };
        _pending.set(attID, st);
    } else {
        st.lastReason = reason;
    }

    if (st.timerID) {
        try { clearTimeout(st.timerID); } catch { }
    }

    st.timerID = setTimeout(() => {
        // não await aqui; Zotero tolera mas preferimos fire-and-forget com catch
        FS_ItemsCreate.tryFinalize(api, attID).catch(e => {
            api.error("ITEM", `create: tryFinalize attID=${attID} failed: ${String(e)}`);
        });
    }, delayMs);
}

// ============================================================
// Public API
// ============================================================

var FS_ItemsCreate = {
    // chamado pelo notifier em add(type=item)
    queue(api, attID, reason = "add") {
        api.debug("ITEM", `create: queued attID=${attID} reason=${reason}`);
        _schedule(api, attID, reason, 350);
    },

    // chamado pelo notifier em modify/refresh(type=item)
    onModify(api, attID, eventName = "modify") {
        if (!_pending.has(attID)) return;
        api.debug("ITEM", `create: poke attID=${attID} via ${eventName}`);
        _schedule(api, attID, eventName, 250);
    },

    async tryFinalize(api, attID) {
        const st = _pending.get(attID);
        if (!st) return;

        st.tries++;

        const att = await Zotero.Items.getAsync(attID);
        if (!att) {
            api.warn("ITEM", `create: pending attID=${attID} disappeared; drop`);
            _pending.delete(attID);
            return;
        }

        const r = await _isAttachmentReady(api, att);
        if (!r.ok) {
            api.debug("ITEM", `create: not ready attID=${attID} tries=${st.tries} why=${r.why}`);

            // guardrail anti-loop: ~20 tentativas (~5-10s dependendo dos eventos)
            if (st.tries >= 20) {
                api.warn("ITEM", `create: giving up attID=${attID} after tries=${st.tries} firstSeenAgeMs=${Date.now() - st.firstSeen}`);
                _pending.delete(attID);
            }
            return;
        }

        api.info("ITEM", `create: READY attID=${attID} tries=${st.tries} -> finalizing`);
        _pending.delete(attID);

        // chama o worker de migração
        await this.onAdd(api, attID);
    },

    // ---- o seu worker: migra STORED -> LINKED ----
    async onAdd(api, id) {
        const item = await Zotero.Items.getAsync(id);
        if (!item) return;

        // só quando nasceu attachment PDF
        if (!item.isAttachment?.()) return;
        if (!_isPDF(item)) return;

        // caminho resolvido
        let storedPDFPath = "";
        try { storedPDFPath = await item.getFilePathAsync?.(); } catch { }
        storedPDFPath = _norm(storedPDFPath || "");

        // só migra STORED (storage)
        if (!storedPDFPath || !_isProbablyStored(storedPDFPath)) return;

        const parentItemID = item.parentItemID;
        if (!parentItemID) return;

        const parentItem = await Zotero.Items.getAsync(parentItemID);
        if (!parentItem) return;

        const plannedFolder = await _winnerPlannedFolderForParentItem(api, parentItem);
        if (!plannedFolder) {
            api.info("ITEM", `create: parent has no collection -> skip migrate attKey=${item.key}`);
            return;
        }

        await _ensureDir(plannedFolder);

        const filename = _plannedPDFName(parentItem);
        const canonical = _norm(`${plannedFolder}/${filename}`);

        // guardrail forte: se já existe LINKED apontando pro canônico, não faz nada
        if (await _hasLinkedAttachmentPointingTo({ parentItem, plannedPath: canonical })) {
            api.info("ITEM", `create: already linked -> canonical, skip STORED migrate attKey=${item.key}`);
            return;
        }

        // colisão: usa _uniquePath só se precisar
        const dst = (await _exists(canonical)) ? await _uniquePath(canonical) : canonical;

        api.info("ITEM", `create: STORED->LINKED attKey=${item.key}`);
        api.info("ITEM", `  storedPDFPath="${storedPDFPath}"`);
        api.info("ITEM", `  plannedFolder="${plannedFolder}"`);
        api.info("ITEM", `  dst="${dst}"`);

        // 1) copy + create linked
        const newAtt = await _copyAndLinkFromStored({
            api,
            parentItem,
            storedAtt: item,
            storedPDFPath,
            plannedAbsPath: dst
        });

        if (!newAtt) {
            api.error("ITEM", `create: failed to create LINKED for attKey=${item.key}`);
            return;
        }

        // 2) transfer annotations
        await _transferAnnotations({ api, oldAtt: item, newAtt });

        // guardrail: se tinha ann, confere se transferiu
        const oldAnn = _getAnnotationItems(item);
        const newAnn = _getAnnotationItems(newAtt);
        if (oldAnn.length && newAnn.length < oldAnn.length) {
            api.error("ITEM", `create: guardrail annotations not fully transferred -> abort delete STORED attKey=${item.key}`);
            return;
        }

        // 3) archive + delete stored
        await _archiveAndDeleteStoredPDF({ api, storedAtt: item, storedPDFPath });

        api.info("ITEM", `create: done attKey=${item.key} -> linkedAttKey=${newAtt.key}`);
    }
};