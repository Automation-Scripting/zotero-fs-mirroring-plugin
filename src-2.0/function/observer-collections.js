// function/observer-collections.js

// function/observer-collections.js

var FS_CollectionsObserver = {
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

    _chainStr(chain) {
        return chain.map(x => `${x.name}(${x.key})`).join(" > ");
    },

    async onAdd(api, id) {
        const col = await Zotero.Collections.getAsync(id);
        if (!col) {
            api.warn("COL", `add id=${id} missing`);
            return;
        }

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "(rootDir not set)";
        const chain = await this._chain(col);
        const desired = this._desiredPath(rootDir, chain);

        api.info("COL", `add id=${id} name="${col.name}" key=${col.key} parentID=${col.parentID || "null"}`);
        api.info("COL", `hierarchy: ${this._chainStr(chain)}`);
        api.info("COL", `desiredPath: ${desired}`);

        // cache para detectar rename/move e delete
        api.colPathCache.set(id, desired);
    },

    async onModify(api, id) {
        const col = await Zotero.Collections.getAsync(id);
        if (!col) {
            api.warn("COL", `modify id=${id} missing (maybe deleted?)`);
            return;
        }

        const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "(rootDir not set)";
        const chain = await this._chain(col);
        const desired = this._desiredPath(rootDir, chain);
        const prev = api.colPathCache.get(id);

        api.info("COL", `modify id=${id} name="${col.name}" key=${col.key} parentID=${col.parentID || "null"}`);
        api.info("COL", `hierarchy: ${this._chainStr(chain)}`);
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
    },

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