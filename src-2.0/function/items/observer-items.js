// function/items/observer-items.js

var FS_ItemsObserver = {
    async onItemTrash(api, id) { return FS_Items.onItemTrash(api, id); },
    async onItemModify(api, id) { return FS_Items.onItemModify(api, id); },
    async onItemDelete(api, id) { return FS_Items.onItemDelete(api, id); },

    // Mantém aqui se você quiser (isso é "observer-level", não item CRUD):
    async onTrashOrDelete(api, event, ids) {
        const now = Date.now();
        if (!api._pendingCollectionDeletes || api._pendingCollectionDeletes.size === 0) return;

        for (const [colID, rec] of api._pendingCollectionDeletes.entries()) {
            if (now - rec.ts <= api._pendingTTLms) continue;

            if (rec.trashedItems.size === 0 && rec.deletedItems.size === 0) {
                api.info("COL",
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
                api.info("COL",
                    `classify colID=${colID} => "Delete Collection and Items" (items trashed=${trashedN} deleted=${deletedN} of ${rec.itemIDs.size})`
                );
            }
        }
    },
};