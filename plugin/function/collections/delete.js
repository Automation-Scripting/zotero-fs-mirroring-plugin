// function/collections/delete.js

var FS_CollectionsDelete = {
    async onDelete(api, id) {
        // Em delete, muitas vezes o objeto já não é acessível
        const prev = api.colPathCache.get(id);

        if (!prev) {
            api.warn("COL", `delete id=${id} (no cache)`);
        } else {
            api.info("COL", `delete id=${id} prevPath="${prev}"`);
            api.colPathCache.delete(id);
        }

        // tentativa best-effort de pegar info (pode falhar)
        try {
            const col = await Zotero.Collections.getAsync(id);
            if (col) {
                api.info("COL", `delete details id=${id} name="${col.name}" key=${col.key} parentID=${col.parentID || "null"}`);
            }
        } catch (e) {
            api.debug("COL", `delete id=${id} details unavailable`);
        }
    }
};