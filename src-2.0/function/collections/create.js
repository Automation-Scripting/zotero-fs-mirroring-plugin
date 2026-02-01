// function/collections/create.js

var FS_CollectionsCreate = {
    async onAdd(api, id) {
        const col = await Zotero.Collections.getAsync(id);
        if (!col) {
            api.warn("COL", `add id=${id} missing`);
            return;
        }

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "(rootDir not set)";
        const chain = await FS_CollectionsRead.chain(col);
        const desired = FS_CollectionsRead.desiredPath(rootDir, chain);

        api.info("COL", `add id=${id} name="${col.name}" key=${col.key} parentID=${col.parentID || "null"}`);
        api.info("COL", `hierarchy: ${FS_CollectionsRead.chainStr(chain)}`);
        api.info("COL", `desiredPath: ${desired}`);

        // cache para detectar rename/move e delete
        api.colPathCache.set(id, desired);
    }
};