// function/collections/read.js

var FS_CollectionsRead = {
    async chain(col) {
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

    sanitize(name) {
        return (name || "Untitled")
            .replace(/[\/\\:\*\?"<>\|]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    },

    desiredPath(rootDir, chain) {
        const segs = chain.map(x => `${this.sanitize(x.name)} [${x.key}]`);
        return [rootDir, ...segs].join("/").replace(/\/+/g, "/");
    },

    chainStr(chain) {
        return chain.map(x => `${x.name}(${x.key})`).join(" > ");
    }
};