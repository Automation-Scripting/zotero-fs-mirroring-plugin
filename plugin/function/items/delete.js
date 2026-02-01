// function/items/delete.js

async function FS_Items_onItemDelete(api, id) {
    if (FS_ItemsCache._shouldIgnoreDelete(api, id)) {
        api.info("ITEM", `delete id=${id} ignored (marked)`);
        FS_ItemsCache._clearIgnoreDelete(api, id);
        return;
    }

    const st = FS_ItemsCache._getCache(api, id);
    if (!st) {
        api.debug("ITEM", `delete id=${id} (no cache)`);
        return;
    }

    if (st.kind !== "ATTACHMENT" || !st.isPDF || st.linkMode !== "LINKED") {
        api.debug("ITEM", `delete id=${id} ignored (cached kind=${st.kind} pdf=${!!st.isPDF} linkMode=${st.linkMode})`);
        FS_ItemsCache._ensureCache(api).delete(Number(id));
        return;
    }

    const candidate = st.lastPath;
    if (!candidate) {
        FS_ItemsCache._ensureCache(api).delete(Number(id));
        return;
    }

    const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
    const rootN = _norm(rootDir);
    if (!rootN || !String(candidate).startsWith(rootN)) {
        FS_ItemsCache._ensureCache(api).delete(Number(id));
        return;
    }

    try {
        if (await _exists(candidate)) {
            await IOUtils.remove(_norm(candidate));
            api.info("ITEM", `DELETE: removed linked file "${candidate}"`);
        } else {
            api.info("ITEM", `DELETE: file already missing "${candidate}"`);
        }
    } catch (e) {
        api.warn("ITEM", `DELETE: failed "${candidate}": ${String(e)}`);
    } finally {
        FS_ItemsCache._ensureCache(api).delete(Number(id));
    }
}