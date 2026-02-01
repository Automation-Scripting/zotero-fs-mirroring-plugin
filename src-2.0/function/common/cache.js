// function/common/cache.js

var FS_ItemsCache = {

    // --------------------
    // ignore delete set
    // --------------------
    _ensureIgnore(api) {
        if (!api._fsMirrorIgnoreDeleteIDs) api._fsMirrorIgnoreDeleteIDs = new Set();
        return api._fsMirrorIgnoreDeleteIDs;
    },
    _markIgnoreDelete(api, id) {
        this._ensureIgnore(api).add(Number(id));
    },
    _shouldIgnoreDelete(api, id) {
        return this._ensureIgnore(api).has(Number(id));
    },
    _clearIgnoreDelete(api, id) {
        this._ensureIgnore(api).delete(Number(id));
    },

    // --------------------
    // cache
    // --------------------
    _ensureCache(api) {
        if (!api._itemFSState) api._itemFSState = new Map(); // id -> { lastPath, trashedPath, attKey, ts, kind, isPDF, linkMode }
        return api._itemFSState;
    },

    _putCache(api, id, data) {
        const m = this._ensureCache(api);
        m.set(Number(id), { ...(m.get(Number(id)) || {}), ...data, ts: Date.now() });
    },

    _getCache(api, id) {
        const m = this._ensureCache(api);
        return m.get(Number(id)) || null;
    },

    // --------------------
    // cache meta (para delete cache-only)
    // --------------------
    async _cacheMetaFromItem(api, item) {
        if (!item) return;

        const id = Number(item.id);

        // kind
        let kind = "OTHER";
        if (item.isAttachment?.()) kind = "ATTACHMENT";
        else if (item.isNote?.()) kind = "NOTE";
        else if (item.isAnnotation?.()) kind = "ANNOTATION";

        // contentType -> isPDF
        const ct = item.attachmentContentType || item.getField?.("contentType") || "";
        const isPDF = (ct === "application/pdf");

        // resolved path
        let p = "";
        try { p = await item.getFilePathAsync?.(); } catch { }
        p = _norm(p);

        // linkMode (por heurística de path)
        const linkMode =
            _isProbablyStored(p) ? "STORED" :
                (_looksAbsolute(p) ? "LINKED" : "OTHER");

        const prev = this._getCache(api, id);

        this._putCache(api, id, {
            kind,
            isPDF,
            linkMode,
            lastPath: p || (prev?.lastPath ?? null),
            attKey: item.key || (prev?.attKey ?? null),
        });
    }
};