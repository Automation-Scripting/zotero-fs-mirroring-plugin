// function/observer-collections.js

var FS_CollectionsObserver = {
    // Constrói o "path lógico" da coleção com base na hierarquia
    async _chain(col) {
        const chain = [];
        let cur = col;

        while (cur) {
            chain.push({
                id: cur.id,
                key: cur.key,
                name: cur.name,
                parentID: cur.parentID
            });
            cur = cur.parentID ? await Zotero.Collections.getAsync(cur.parentID) : null;
        }
        return chain.reverse();
    },

    _sanitize(name) {
        return (name || "Untitled")
            .replace(/[\/\\:\*\?"<>\|]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    },

    _desiredPath(rootDir, chain) {
        const segs = chain.map(x => `${this._sanitize(x.name)} [${x.key}]`);
        return [rootDir, ...segs].join("/").replace(/\/+/g, "/");
    },

    async onAdd(api, id) {
        const col = await Zotero.Collections.getAsync(id);
        if (!col) {
            api.warn("COL", `add id=${id} missing`);
            return;
        }

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "(rootDir not set)";
        const chain = await this._chain(col);
        const chainStr = chain.map(x => `${x.name}(${x.key})`).join(" > ");
        const desired = this._desiredPath(rootDir, chain);

        api.info("COL", `add id=${id} name="${col.name}" key=${col.key} parentID=${col.parentID || "null"}`);
        api.info("COL", `hierarchy: ${chainStr}`);
        api.info("COL", `desiredPath: ${desired}`);
    }
};