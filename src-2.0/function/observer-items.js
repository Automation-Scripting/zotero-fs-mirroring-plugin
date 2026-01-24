// function/observer-items.js

function _norm(p) {
    return String(p || "").replace(/\/+/g, "/");
}

function _isLikelyLinkedPath(p) {
    const s = _norm(p);
    return !!s && s.startsWith("/") && !s.includes("/storage/");
}

function _isPDF(att) {
    const ct = att.attachmentContentType || att.getField?.("contentType") || "";
    return ct === "application/pdf";
}

var FS_ItemsObserver = {
    // -------------------------
    // CLASSIFIER (mantém)
    // -------------------------
    async onTrashOrDelete(api, event, ids) {
        const now = Date.now();

        if (!api._pendingCollectionDeletes || api._pendingCollectionDeletes.size === 0) return;

        for (const [colID, rec] of api._pendingCollectionDeletes.entries()) {
            if (now - rec.ts <= api._pendingTTLms) continue;

            if (rec.trashedItems.size === 0 && rec.deletedItems.size === 0) {
                api.info(
                    "COL",
                    `classify colID=${colID} => "Delete Collection (only)" (0 items trashed/deleted of ${rec.itemIDs.size})`
                );
            }
            api._pendingCollectionDeletes.delete(colID);
        }

        for (const [colID, rec] of api._pendingCollectionDeletes.entries()) {
            if (now - rec.ts > api._pendingTTLms) continue;

            for (const itemID of (ids || [])) {
                if (!rec.itemIDs.has(itemID)) continue;

                if (event === "trash") rec.trashedItems.add(itemID);
                else if (event === "delete") rec.deletedItems.add(itemID);
            }

            const trashedN = rec.trashedItems.size;
            const deletedN = rec.deletedItems.size;

            if (trashedN || deletedN) {
                api.info(
                    "COL",
                    `classify colID=${colID} => "Delete Collection and Items" (items trashed=${trashedN} deleted=${deletedN} of ${rec.itemIDs.size})`
                );
            }
        }
    },

    // -------------------------
    // NEW: item handlers
    // -------------------------
    async onItemTrash(api, itemID) {
        // Não apaga em "trash" (permite undo do Zotero). Só log.
        const it = await Zotero.Items.getAsync(itemID);
        if (!it || !it.isAttachment?.() || !_isPDF(it)) return;

        let p = "";
        try { p = await it.getFilePathAsync(); } catch { }
        api.info("ITEM", `trash attID=${itemID} key=${it.key} path="${p || "(missing)"}" (no FS delete on trash)`);
    },

    async onItemDelete(api, itemID) {
        const it = await Zotero.Items.getAsync(itemID);
        if (!it || !it.isAttachment?.() || !_isPDF(it)) return;

        let p = "";
        try { p = await it.getFilePathAsync(); } catch { }
        p = _norm(p);

        // Só queremos apagar LINKED dentro do rootDir (guardrail forte)
        const rootDir = _norm(Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "");
        if (!rootDir) {
            api.warn("ITEM", `delete attID=${itemID} key=${it.key} rootDir not set (skip FS delete)`);
            return;
        }

        if (!_isLikelyLinkedPath(p)) {
            api.debug("ITEM", `delete attID=${itemID} key=${it.key} not LINKED path="${p}" (skip FS delete)`);
            return;
        }

        if (!p.startsWith(rootDir + "/") && p !== rootDir) {
            api.warn("ITEM", `guardrail: linked path outside rootDir, NOT deleting "${p}"`);
            return;
        }

        // Apaga do filesystem
        try {
            if (await IOUtils.exists(p)) {
                await IOUtils.remove(p);
                api.info("ITEM", `FS deleted linked pdf path="${p}" attKey=${it.key}`);
            } else {
                api.warn("ITEM", `FS delete skipped (file missing) path="${p}" attKey=${it.key}`);
            }
        } catch (e) {
            api.error("ITEM", `FS delete failed path="${p}" attKey=${it.key}: ${String(e)}`);
        }
    }
};