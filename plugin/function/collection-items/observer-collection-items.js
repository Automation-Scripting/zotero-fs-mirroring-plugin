// function/collection-items/observer-collection-items.js
// Depende de: Zotero.Collections, Zotero.Items

function _parseCollectionItemPair(x) {
  // O teu build manda "703-10491"
  if (typeof x === "string" && x.includes("-")) {
    const [a, b] = x.split("-", 2);
    const colID = Number(a);
    const itemID = Number(b);
    if (Number.isFinite(colID) && Number.isFinite(itemID)) return { colID, itemID };
  }

  // fallback (caso algum build mande objeto)
  if (x && typeof x === "object") {
    const colID = Number(x.collectionID ?? x.colID);
    const itemID = Number(x.itemID ?? x.id);
    if (Number.isFinite(colID) && Number.isFinite(itemID)) return { colID, itemID };
  }

  return null;
}

async function _removeItemFromCollection(api, colID, itemID) {
  const col = await Zotero.Collections.getAsync(colID);
  if (!col) return;

  try {
    if (typeof col.removeItems === "function") {
      col.removeItems([itemID]);
    } else if (typeof col.removeItem === "function") {
      col.removeItem(itemID);
    } else {
      api.warn("COLITEM", `collection id=${colID} has no removeItem(s) API`);
      return;
    }

    if (typeof col.saveTx === "function") await col.saveTx();
    else if (typeof col.save === "function") await col.save();

    api.info("COLITEM", `removed itemID=${itemID} from colID=${colID}`);
  } catch (e) {
    api.error("COLITEM", `failed removing itemID=${itemID} from colID=${colID}: ${String(e)}`);
  }
}

var FS_CollectionItemsObserver = {
  async onAdd(api, pair) {
    const p = _parseCollectionItemPair(pair);
    if (!p) {
      api.warn("COLITEM", `onAdd: could not parse id=${String(pair)}`);
      return;
    }

    const { colID: destColID, itemID } = p;

    // pref pra ligar/desligar o "drag vira move"
    const enabled = !!Zotero.Prefs.get("extensions.fs-mirror.dragMoveSingleCollection", true);
    api.info("COLITEM", `add: destColID=${destColID} itemID=${itemID} enabled=${enabled}`);

    if (!enabled) return;

    const item = await Zotero.Items.getAsync(itemID);
    if (!item) return;

    // coleções atuais do item (depois do drag)
    const colIDs = item.getCollections?.() || [];
    if (!colIDs.length) return;

    // remove de todas exceto a dest
    const toRemove = colIDs.filter(cid => Number(cid) !== Number(destColID));

    // Se por algum motivo o item ainda não “tem” a dest na lista, não faz nada
    if (!colIDs.includes(destColID)) {
      api.warn("COLITEM", `add: itemID=${itemID} does not list destColID=${destColID} in getCollections(); skip`);
      return;
    }

    if (!toRemove.length) {
      api.info("COLITEM", `add: itemID=${itemID} already only in destColID=${destColID}`);
      return;
    }

    api.info("COLITEM", `add: enforcing single-collection: itemID=${itemID} removeFrom=[${toRemove.join(",")}] keep=${destColID}`);

    for (const cid of toRemove) {
      await _removeItemFromCollection(api, cid, itemID);
    }
  },

  async onRemove(api, pair) {
    // a gente não precisa fazer nada aqui por enquanto
    const p = _parseCollectionItemPair(pair);
    if (!p) return;
    api.debug("COLITEM", `remove: colID=${p.colID} itemID=${p.itemID} (ignored)`);
  }
};