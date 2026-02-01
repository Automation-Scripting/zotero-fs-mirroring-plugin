// function/collections/create.js
// depende de: _norm, _exists, _ensureDir, _listDirNames, _isDir
// depende de: _parentDir
// depende de: FS_CollectionsRead (chain, desiredPath, chainStr)

async function _findDirByKeyInParent(parentDir, colKey) {
    const suffix = ` [${colKey}]`;
    parentDir = _norm(parentDir);

    const names = await _listDirNames(parentDir);
    for (const name of names) {
        if (!name.endsWith(suffix)) continue;
        const full = _norm(parentDir + "/" + name);
        if (await _isDir(full)) return full;
    }
    return null;
}

var FS_CollectionsCreate = {
    async onAdd(api, id) {
        const col = await Zotero.Collections.getAsync(id);
        if (!col) {
            api.warn("COL", `add id=${id} missing`);
            return;
        }

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
        if (!rootDir) {
            api.warn("COL", `add id=${id} rootDir not set -> skip`);
            return;
        }

        const chain = await FS_CollectionsRead.chain(col);
        const desired0 = _norm(FS_CollectionsRead.desiredPath(rootDir, chain));

        api.info("COL", `add id=${id} name="${col.name}" key=${col.key} parentID=${col.parentID || "null"}`);
        api.info("COL", `hierarchy: ${FS_CollectionsRead.chainStr(chain)}`);
        api.info("COL", `desiredPath: ${desired0}`);

        const parentDir = _parentDir(desired0);

        // 1) Se já existe pasta com o mesmo [key] no parent, usa ela (evita duplicatas)
        const byKey = await _findDirByKeyInParent(parentDir, col.key);

        let finalPath = desired0;

        if (byKey) {
            api.warn("COL", `add: found existing dir by key -> "${byKey}" (skip create)`);
            finalPath = byKey;
        } else {
            // 2) Cria diretório (idempotente)
            try {
                await _ensureDir(desired0);
                api.info("COL", `add: ensured dir -> "${desired0}"`);
            } catch (e) {
                api.error("COL", `add: ensure dir failed "${desired0}": ${String(e)}`);
                return;
            }
        }

        // 3) Cache para rename/move/delete
        api.colPathCache.set(id, finalPath);
    }
};