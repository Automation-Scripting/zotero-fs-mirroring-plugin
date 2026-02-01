// function/items/update.js
// depende de: _norm, _uniquePath, _exists, _moveFile, _removeDirIfEmpty, _parentDir
// depende de: _isAttachmentItem, _isInTrash
// depende de: FS_ItemsCache (cache.js)
// depende de: _restoreOneFromNote e _setLinkedAttachmentPath (trash.js)

async function FS_Items_onItemModify(api, id) {
    const item = await Zotero.Items.getAsync(id);
    if (!item) return;

    await FS_ItemsCache._cacheMetaFromItem(api, item);

    if (_isInTrash(item)) return;

    // Caso A) modify do ATTACHMENT
    if (_isAttachmentItem(item)) {
        await FS_ItemsCache._cacheMetaFromItem(api, item);

        const ok = await _restoreOneFromNote(api, item);
        if (ok) return;

        const st = FS_ItemsCache._getCache(api, id);
        if (!st || !st.trashedPath || !st.lastPath) return;

        const from = _norm(st.trashedPath);
        const to0 = _norm(st.lastPath);

        if (!(await _exists(from))) {
            FS_ItemsCache._putCache(api, id, { trashedPath: null });
            return;
        }

        const to = await _uniquePath(to0);

        try {
            api.info("ITEM", `RESTORE(cache): move back "${from}" -> "${to}"`);
            await _moveFile(from, to);

            // vem do trash.js
            await _setLinkedAttachmentPath(item, to);
            api.info("ITEM", `RESTORE(cache): updated attachment path -> "${to}"`);

            await _removeDirIfEmpty(_parentDir(from));
            FS_ItemsCache._putCache(api, id, { lastPath: to, trashedPath: null });
        } catch (e) {
            api.error("ITEM", `restore(cache) failed id=${id}: ${String(e)}`);
        }
        return;
    }

    // Caso B) modify do PARENT (restore pela UI)
    const attIDs = item.getAttachments?.() || [];
    if (!attIDs.length) return;

    api.info("ITEM", `RESTORE(parent-modify): id=${id} attachments=[${attIDs.join(",")}]`);

    for (const attID of attIDs) {
        const att = await Zotero.Items.getAsync(attID);
        if (!att || !_isAttachmentItem(att)) continue;

        await FS_ItemsCache._cacheMetaFromItem(api, att);
        await _restoreOneFromNote(api, att); // vem do trash.js
    }
}