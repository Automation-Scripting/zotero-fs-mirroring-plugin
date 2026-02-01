// function/collections/update.js

var FS_CollectionsUpdate = {
    async onModify(api, id) {
        const col = await Zotero.Collections.getAsync(id);
        if (!col) {
            api.warn("COL", `modify id=${id} missing (maybe deleted?)`);
            return;
        }

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "(rootDir not set)";
        const chain = await FS_CollectionsRead.chain(col);
        const desired = FS_CollectionsRead.desiredPath(rootDir, chain);
        const prev = api.colPathCache.get(id);

        api.info("COL", `modify id=${id} name="${col.name}" key=${col.key} parentID=${col.parentID || "null"}`);
        api.info("COL", `hierarchy: ${FS_CollectionsRead.chainStr(chain)}`);
        api.info("COL", `desiredPath: ${desired}`);

        if (!prev) {
            api.warn("COL", `modify id=${id} (no cache) -> set cache="${desired}"`);
            api.colPathCache.set(id, desired);
            return;
        }

        if (prev === desired) {
            api.debug("COL", `modify id=${id} no path change`);
            return;
        }

        // aqui é o que nos interessa: rename/move
        api.info("COL", `rename/move id=${id} "${prev}" -> "${desired}"`);

        // atualiza cache
        api.colPathCache.set(id, desired);
    }
};