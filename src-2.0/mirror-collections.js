/* global Zotero */

var FSMirrorCollections = {
    async handle({ api, fs, event, ids }) {
        const rootDir = api.pref("rootDir");
        const dryRun = !!api.pref("dryRun");
        const trashName = api.pref("safeTrashDirName") || "_FSMirror_Trash";

        api.log("INFO", "COL", `event=${event} ids=[${(ids || []).join(",")}]`);

        for (const id of ids || []) {
            if (event === "add") await this._onAdd({ api, fs, rootDir, dryRun, id });
            else if (event === "modify") await this._onModify({ api, fs, rootDir, dryRun, id });
            else if (event === "delete") await this._onDelete({ api, fs, rootDir, dryRun, trashName, id });
            else api.log("DEBUG", "COL", `ignored event=${event}`);
        }
    },

    async _onAdd({ api, fs, rootDir, dryRun, id }) {
        const col = await Zotero.Collections.getAsync(id);
        if (!col) return api.log("WARN", "COL", `add id=${id} missing`);

        const dst = await this._desiredPath(rootDir, col);
        await fs.ensureDir(dst, (m) => api.log("INFO", "FS", m), dryRun);

        api.colPathCache.set(id, dst);
        api.log("INFO", "COL", `add id=${id} -> "${dst}"`);
    },

    async _onModify({ api, fs, rootDir, dryRun, id }) {
        const col = await Zotero.Collections.getAsync(id);
        if (!col) return api.log("WARN", "COL", `modify id=${id} missing`);

        const dst = await this._desiredPath(rootDir, col);
        const prev = api.colPathCache.get(id);

        if (!prev) {
            api.colPathCache.set(id, dst);
            api.log("WARN", "COL", `modify id=${id} no cache; set="${dst}"`);
            if (!(await fs.exists(dst))) {
                await fs.ensureDir(dst, (m) => api.log("INFO", "FS", m), dryRun);
            }
            return;
        }

        if (prev === dst) {
            api.log("DEBUG", "COL", `modify id=${id} no path change`);
            return;
        }

        if (await fs.exists(prev)) {
            await fs.moveDir(prev, dst, (m) => api.log("INFO", "FS", m), dryRun);
        } else {
            api.log("WARN", "COL", `prev missing "${prev}" -> create "${dst}"`);
            await fs.ensureDir(dst, (m) => api.log("INFO", "FS", m), dryRun);
        }

        api.colPathCache.set(id, dst);
        api.log("INFO", "COL", `rename/move id=${id} "${prev}" -> "${dst}"`);
    },

    async _onDelete({ api, fs, rootDir, dryRun, trashName, id }) {
        const prev = api.colPathCache.get(id);

        if (!prev) {
            api.log("WARN", "COL", `delete id=${id} no cache`);
            return;
        }

        await fs.trashMove(prev, rootDir, trashName, (m) => api.log("INFO", "FS", m), dryRun);
        api.colPathCache.delete(id);
        api.log("INFO", "COL", `delete id=${id} trashed "${prev}"`);
    },

    async _desiredPath(rootDir, col) {
        const chain = await this._chain(col);
        const segs = chain.map(x => `${this._sanitize(x.name)} [${x.key}]`);
        return [rootDir, ...segs].join("/").replace(/\/+/g, "/");
    },

    async _chain(col) {
        const chain = [];
        let cur = col;
        while (cur) {
            chain.push({ id: cur.id, key: cur.key, name: cur.name, parentID: cur.parentID });
            cur = cur.parentID ? await Zotero.Collections.getAsync(cur.parentID) : null;
        }
        return chain.reverse();
    },

    _sanitize(name) {
        return (name || "Untitled")
            .replace(/[\/\\:\*\?"<>\|]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }
};