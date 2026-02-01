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

// move attachments que estão em prevDir/* para unfiledBase/<basename(prevDir)>/*
async function _moveLinkedAttachmentsOutOfCollectionDir(api, parentIDs, prevDir, rootDir, unfiledFolder) {
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

            // não toca storage do Zotero
            if (_isProbablyStored(oldN)) continue;

            // só os que estavam dentro da pasta da coleção deletada
            if (!oldN.startsWith(prevPrefix)) continue;

            const rel = oldN.slice(prevPrefix.length);        // relativo dentro da pasta
            const dst0 = _norm(base + "/" + rel);             // mantém subpastas se existirem
            await _ensureDir(_parentDir(dst0));
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


// function/collections/delete.js

var FS_CollectionsDelete = {
    async onDelete(api, id) {
        const prev0 = api.colPathCache.get(id);
        const prev = prev0 ? _norm(prev0) : null;

        api.info("COL", `delete id=${id} prevPath=${prev ? JSON.stringify(prev) : "null"}`);

        // cleanup cache já
        api.colPathCache.delete(id);

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const unfiledFolder = Zotero.Prefs.get("extensions.fs-mirror.unfiledFolder", true) || "_FSMirror_Unfiled";

        try {
            // 1) subtree
            const colIDs = await _listCollectionIDsSubtree(id);

            // 2) coletar parentIDs (antes de mexer nas coleções)
            const parentIDs = await _collectParentIDsFromCollections(colIDs);
            api.debug("COL", `delete: parentIDs=${parentIDs.length}`);

            // 3) mover attachments do dir da coleção -> unfiled (FS) + atualizar linked paths
            if (prev && rootDir && (await _exists(prev))) {
                await _ensureDir(_norm(rootDir + "/" + unfiledFolder));
                await _moveLinkedAttachmentsOutOfCollectionDir(api, parentIDs, prev, rootDir, unfiledFolder);

                // tenta limpar pasta antiga
                await _removeDirIfEmpty(prev);
            } else {
                api.warn("COL", `delete: prev missing or rootDir unset -> skip FS move`);
            }

            // 4) Zotero: remover itens das coleções (vira Unfiled)
            await _unfileItemsFromCollections(api, colIDs);

        } catch (e) {
            api.error("COL", `delete id=${id} failed: ${String(e)}`);
        }
    }
};