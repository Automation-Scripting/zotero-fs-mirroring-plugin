// function/observer-items.js

var FS_ItemsObserver = {
    // Só observa efeitos de deleção (trash/delete) para classificar
    async onTrashOrDelete(api, event, ids) {
        const now = Date.now();

        // Se não há coleções pendentes, não faz nada
        if (!api._pendingCollectionDeletes || api._pendingCollectionDeletes.size === 0) return;

        // Limpa trackers expirados (e fecha classificação "Delete Collection only" se não teve itens)
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

        // Marca itens afetados dentro da janela
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
                // você pode remover aqui se quiser “uma vez só”
                // api._pendingCollectionDeletes.delete(colID);
            }
        }
    }
};