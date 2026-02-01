// function/collections/delete.js
// depende de: _norm, _exists, _ensureDir, _moveFile, _uniquePath, _parentDir
// depende de: _isProbablyStored (common/path.js)
// depende de: PathUtils, IOUtils
// depende de: _setLinkedAttachmentPath (trash.js)
// opcional: _isDir (se não tiver, use o fallback try/catch com IOUtils.getChildren)

function _asItemID(x) {
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
    if (x && typeof x === "object" && Number.isFinite(x.id)) return x.id;
    return null;
}

async function _listCollectionIDsSubtree(rootColID) {
    const out = [];
    const stack = [rootColID];
    while (stack.length) {
        const cid = stack.pop();
        out.push(cid);
        const kids = Zotero.Collections.getByParent(cid) || [];
        for (const c of kids) stack.push(c.id);
    }
    return out;
}

async function _collectParentIDsFromCollections(colIDs) {
    const parentIDs = new Set();
    for (const cid of colIDs) {
        const c = await Zotero.Collections.getAsync(cid);
        if (!c) continue;
        const xs = c.getChildItems?.() || [];
        for (const x of xs) {
            const pid = _asItemID(x);
            if (pid != null) parentIDs.add(pid);
        }
    }
    return [...parentIDs];
}

// ---- FS walk (para fallback) ----
async function _walkFiles(dir) {
    dir = _norm(dir);
    const out = [];

    if (typeof IOUtils.getChildren !== "function") return out;

    const kids = await IOUtils.getChildren(dir);
    for (const p of kids) {
        const pp = _norm(p);

        // ignora DS_Store (flat/fallback)
        if (PathUtils.filename(pp) === ".DS_Store") continue;

        let isDir = false;
        try {
            if (typeof _isDir === "function") {
                isDir = await _isDir(pp);
            } else {
                await IOUtils.getChildren(pp);
                isDir = true;
            }
        } catch {
            isDir = false;
        }

        if (isDir) out.push(...await _walkFiles(pp));
        else out.push(pp);
    }

    return out;
}

// ---- relink global (flat) ----
async function _relinkUsingMovedMap(api, prevDir, movedMap) {
    prevDir = _norm(prevDir);
    const prevPrefix = prevDir.endsWith("/") ? prevDir : (prevDir + "/");

    let changed = 0;

    const s = new Zotero.Search();
    s.addCondition("itemType", "is", "attachment");
    const attIDs = await s.search();

    for (const aid of attIDs) {
        const att = await Zotero.Items.getAsync(aid);
        if (!att || !att.isAttachment?.()) continue;

        const oldPath = att.getFilePath?.() || att.attachmentPath;
        if (!oldPath) continue;

        const oldN = _norm(oldPath);
        if (_isProbablyStored(oldN)) continue;
        if (!oldN.startsWith(prevPrefix)) continue;

        // tenta mapear pelo caminho completo
        let newPath = movedMap.get(oldN);

        // fallback: se não achou (caso raro), tenta por basename dentro do mapa
        if (!newPath) {
            const bn = PathUtils.filename(oldN);
            for (const [k, v] of movedMap.entries()) {
                if (PathUtils.filename(k) === bn) { newPath = v; break; }
            }
        }

        if (!newPath) {
            api.warn("COL", `delete: relink(map) no dst for att id=${att.id} old=${JSON.stringify(oldN)}`);
            continue;
        }

        api.info("COL", `delete: relink(map) att id=${att.id} "${oldN}" -> "${newPath}"`);
        await _setLinkedAttachmentPath(att, newPath);
        changed++;
    }

    api.info("COL", `delete: relink(map) changed=${changed}`);
    return changed;
}

async function _rewriteAllLinkedAttachmentsWithPrefix_Flat(api, prevDir, newBase) {
    prevDir = _norm(prevDir);
    newBase = _norm(newBase);
    const prevPrefix = prevDir.endsWith("/") ? prevDir : (prevDir + "/");

    let changed = 0;

    // Busca attachments (sem depender de getAll)
    const s = new Zotero.Search();
    s.addCondition("itemType", "is", "attachment");
    const attIDs = await s.search();

    api.info("COL", `delete: relink(flat) candidates=${attIDs.length} prevPrefix=${JSON.stringify(prevPrefix)}`);

    for (const aid of attIDs) {
        const att = await Zotero.Items.getAsync(aid);
        if (!att || !att.isAttachment?.()) continue;

        const oldPath = att.getFilePath?.() || att.attachmentPath;
        if (!oldPath) continue;

        const oldN = _norm(oldPath);

        // só LINKED (não storage)
        if (_isProbablyStored(oldN)) continue;

        // só os que estavam dentro da pasta deletada
        if (!oldN.startsWith(prevPrefix)) continue;

        // FLAT: basename
        const dst0 = _norm(newBase + "/" + PathUtils.filename(oldN));
        const dst = await _uniquePath(dst0);

        api.info("COL", `delete: relink(flat) att id=${att.id} "${oldN}" -> "${dst}"`);
        await _setLinkedAttachmentPath(att, dst);
        changed++;
    }

    api.info("COL", `delete: relink(flat) changed=${changed}`);
    return changed;
}

// ---- move via parents (flat) ----
async function _moveLinkedAttachmentsOutOfCollectionDir_Flat(api, parentIDs, prevDir, rootDir, unfiledFolder) {
    prevDir = _norm(prevDir);
    const prevPrefix = prevDir.endsWith("/") ? prevDir : (prevDir + "/");

    const base = _norm(rootDir + "/" + unfiledFolder);
    await _ensureDir(base);

    let moved = 0;

    for (const pid of parentIDs) {
        const parent = await Zotero.Items.getAsync(pid);
        if (!parent) continue;

        const attIDs = parent.getAttachments?.() || [];
        for (const x of attIDs) {
            const aid = _asItemID(x);
            if (aid == null) continue;

            const att = await Zotero.Items.getAsync(aid);
            if (!att || !att.isAttachment?.()) continue;

            const oldPath = att.getFilePath?.() || att.attachmentPath;
            if (!oldPath) continue;

            const oldN = _norm(oldPath);
            if (_isProbablyStored(oldN)) continue;
            if (!oldN.startsWith(prevPrefix)) continue;

            // FLAT: só filename
            const name = PathUtils.filename(oldN);
            const dst0 = _norm(base + "/" + name);
            const dst = await _uniquePath(dst0);

            api.info("COL", `delete: move att "${oldN}" -> "${dst}"`);

            await _moveFile(oldN, dst);
            await _setLinkedAttachmentPath(att, dst);

            moved++;
        }
    }

    api.info("COL", `delete: moved=${moved} linked attachment(s) to unfiled`);
    return moved;
}

async function _unfileItemsFromCollections(api, colIDs) {
    let totalRemoved = 0;

    for (const cid of colIDs) {
        const c = await Zotero.Collections.getAsync(cid);
        if (!c) continue;

        const ids = (c.getChildItems?.() || []).map(_asItemID).filter(x => x != null);
        if (!ids.length) continue;

        try {
            if (typeof c.removeItems === "function") c.removeItems(ids);
            else if (typeof c.removeItem === "function") for (const id of ids) c.removeItem(id);
            else {
                api.warn("COL", `unfile: collection id=${cid} has no removeItem(s) API`);
                continue;
            }

            if (typeof c.saveTx === "function") await c.saveTx();
            else if (typeof c.save === "function") await c.save();

            totalRemoved += ids.length;
        } catch (e) {
            api.error("COL", `unfile: failed collection id=${cid}: ${String(e)}`);
        }
    }

    api.info("COL", `unfile: totalRemoved=${totalRemoved}`);
}

var FS_CollectionsDelete = {

    async onDelete(api, id) {

        const movedMap = new Map(); // oldFullPath -> newFullPath
        const prev0 = api.colPathCache.get(id);
        const prev = prev0 ? _norm(prev0) : null;

        api.info("COL", `delete id=${id} prevPath=${prev ? JSON.stringify(prev) : "null"}`);

        api.colPathCache.delete(id);

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const unfiledFolder = Zotero.Prefs.get("extensions.fs-mirror.unfiledFolder", true) || "_FSMirror_Unfiled";

        try {
            const colIDs = await _listCollectionIDsSubtree(id);
            const parentIDs = await _collectParentIDsFromCollections(colIDs);
            api.debug("COL", `delete: parentIDs=${parentIDs.length}`);

            let moved = 0;

            if (prev && rootDir && (await _exists(prev))) {
                const base = _norm(rootDir + "/" + unfiledFolder);
                await _ensureDir(base);

                // (A) tenta pelo caminho “bonito” via parentIDs
                moved = await _moveLinkedAttachmentsOutOfCollectionDir_Flat(api, parentIDs, prev, rootDir, unfiledFolder);

                // (B) fallback: parentIDs=0 ou moved=0 => move tudo por FS + relink global
                if (moved === 0) {
                    api.warn("COL", `delete: moved=0 via parent-scan; fallback to FS recursive FLAT move + global relink`);

                    const files = await _walkFiles(prev);
                    for (const src of files) {
                        const name = PathUtils.filename(src);
                        if (name === ".DS_Store" || name.startsWith("._")) continue;

                        const dst0 = _norm(base + "/" + name);
                        const dst = await _uniquePath(dst0);

                        await _moveFile(src, dst);
                        moved++;
                        movedMap.set(_norm(src), _norm(dst));
                    }

                    api.info("COL", `delete: fallback movedFS=${moved} now relinking...`);
                    const relinked = await _relinkUsingMovedMap(api, prev, movedMap);
                    api.info("COL", `delete: fallback relinked=${relinked}`);

                    // remove árvore antiga (recursivo)
                    try { await IOUtils.remove(_norm(prev), { recursive: true }); } catch { }
                } else {
                    // se moveu algo, tenta limpar apenas se estiver vazio
                    await _removeDirIfEmpty(prev);
                }

            } else {
                api.warn("COL", `delete: prev missing or rootDir unset -> skip FS move`);
            }

            // Zotero: desassocia itens (vira Unfiled)
            await _unfileItemsFromCollections(api, colIDs);

        } catch (e) {
            api.error("COL", `delete id=${id} failed: ${String(e)}`);
        }
    }
};