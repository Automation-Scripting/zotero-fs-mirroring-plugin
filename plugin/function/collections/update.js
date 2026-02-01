// function/collections/update.js
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

        // Zotero.Collections.getByParent(parentID) costuma existir
        const kids = Zotero.Collections.getByParent(cid) || [];
        for (const c of kids) stack.push(c.id);
    }
    return out;
}

async function _searchItemIDsInCollectionIDs(colIDs) {
    const itemIDs = new Set();

    for (const cid of colIDs) {
        const s = new Zotero.Search();
        s.addCondition("collectionID", "is", cid);
        const ids = await s.search();
        for (const id of ids) itemIDs.add(id);
    }
    return [...itemIDs];
}

function _withSlash(p) {
    p = _norm(p);
    return p.endsWith("/") ? p : (p + "/");
}

async function _rewriteLinkedAttachmentPathsInDir(api, col, prevDir, newDir) {
    prevDir = _norm(prevDir);
    newDir = _norm(newDir);

    const prevPrefix = prevDir.endsWith("/") ? prevDir : (prevDir + "/");

    // ---- subtree (coleções) ----
    const colIDs = await _listCollectionIDsSubtree(col.id);
    api.debug("COL", `rewrite: subtree colIDs=${JSON.stringify(colIDs)}`);

    // ---- parentIDs via Collections API (sem Search) ----
    const parentIDs = new Set();
    for (const cid of colIDs) {
        const c = await Zotero.Collections.getAsync(cid);
        if (!c) continue;

        const xs = c.getChildItems?.() || [];
        for (const x of xs) {
            const pid = _asItemID(x);
            if (pid != null) parentIDs.add(pid);
            else api.debug("COL", `rewrite: skip non-id childItem=${String(x)}`);
        }
    }
    api.debug("COL", `rewrite: parentIDs=${parentIDs.size}`);

    // ---- attachments via parents ----
    const attIDs = new Set();
    for (const pid of parentIDs) {
        const parent = await Zotero.Items.getAsync(pid);
        if (!parent) continue;

        const ys = parent.getAttachments?.() || [];
        for (const y of ys) {
            const aid = _asItemID(y);
            if (aid != null) attIDs.add(aid);
            else api.debug("COL", `rewrite: skip non-id attachment=${String(y)} parent=${pid}`);
        }
    }
    api.debug("COL", `rewrite: attIDs=${attIDs.size}`);

    let changed = 0;

    for (const aid of attIDs) {
        if (!Number.isFinite(aid)) continue; // redundância proposital
        const att = await Zotero.Items.getAsync(aid);
        if (!att || !att.isAttachment?.()) continue;

        const oldPath = att.getFilePath?.() || att.attachmentPath;
        if (!oldPath) continue;

        const oldN = _norm(oldPath);

        if (_isProbablyStored(oldN)) continue;
        if (!oldN.startsWith(prevPrefix)) continue;

        const newPath = _norm(newDir + oldN.slice(prevDir.length));

        api.info("COL", `rewrite att id=${att.id} "${oldN}" -> "${newPath}"`);
        await _setLinkedAttachmentPath(att, newPath);
        changed++;
    }

    api.info("COL", `rewriteLinkedAttachmentPathsInDir: changed=${changed}`);
}

async function _findCollectionDirByKey(api, parentDir, colKey) {
    const suffix = ` [${colKey}]`;

    if (!(await _exists(parentDir))) return null;

    const names = await _listDirNames(parentDir);
    api.debug(
        "COL",
        `scan parentDir="${parentDir}" entries=${JSON.stringify(names)}`
    );

    for (const name of names) {
        if (!name.endsWith(suffix)) continue;

        const full = _norm(parentDir + "/" + name);
        if (await _isDir(full)) return full;
    }

    return null;
}

var FS_CollectionsUpdate = {
    async onModify(api, id) {
        const col = await Zotero.Collections.getAsync(id);
        if (!col) {
            api.warn("COL", `modify id=${id} missing (maybe deleted?)`);
            return;
        }

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        const chain = await FS_CollectionsRead.chain(col);
        const desired = _norm(FS_CollectionsRead.desiredPath(rootDir, chain));
        const prev = api.colPathCache.get(id);

        api.info("COL", `modify id=${id} name="${col.name}" key=${col.key} parentID=${col.parentID || "null"}`);
        api.info("COL", `desiredPath: ${desired}`);

        // ----------------------------
        // 1) fallback: acha pelo [key]
        // ----------------------------
        const desiredParent = PathUtils.parent(desired);
        const fsFound = await _findCollectionDirByKey(api, desiredParent, col.key);

        // Se o cache falhar (ou tiver criado pasta nova), usamos o fsFound como "prev real"
        const prevEffective = prev ? _norm(prev) : fsFound;

        if (!prevEffective) {
            api.warn("COL", `modify id=${id} no cache and no fs match -> set cache="${desired}"`);
            api.colPathCache.set(id, desired);
            return;
        }

        if (prevEffective === desired) {
            api.debug("COL", `modify id=${id} no path change`);
            api.colPathCache.set(id, desired);
            return;
        }

        api.info("COL", `rename/move id=${id} "${prevEffective}" -> "${desired}"`);

        // ----------------------------
        // 2) regra anti-"duplicou pasta"
        // ----------------------------
        const prevExists = await _exists(prevEffective);
        const desiredExists = await _exists(desired);

        if (prevExists && !desiredExists) {
            await _moveDir(prevEffective, desired);
            await _rewriteLinkedAttachmentPathsInDir(api, col, prevEffective, desired);
        } else if (prevExists && desiredExists) {
            // Esse é EXATAMENTE o cenário do seu print (sanitizou e criou a nova).
            // Aqui a escolha segura é: NÃO sobrescrever.
            // Opção A (segura): avisar e não mexer automaticamente.
            api.warn("COL",
                `both prev and desired exist; refusing auto-merge. prev="${prevEffective}" desired="${desired}"`
            );
            // você pode optar por mover prev -> trash/ ou fazer merge controlado em outro método.
        } else if (!prevExists && desiredExists) {
            // ok: já está no lugar "novo"
            api.debug("COL", `prev missing but desired exists; assume already moved`);
        } else {
            api.warn("COL", `neither prev nor desired exists on disk; just set cache`);
        }

        // cache sempre atualizado pro desired (ou você pode setar pro prev se recusou merge)
        api.colPathCache.set(id, desired);

        // opcional: também atualizar descendentes no cache como discutimos
        // _updateDescendantCaches(api.colPathCache, prevEffective, desired);
    }
};