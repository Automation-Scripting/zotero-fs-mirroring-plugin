// core/notifier.js

(function () {
  FS_Mirror._notifierID = null;

  FS_Mirror._registerObservers = function () {
    if (this._notifierID) return;

    const observer = {
      notify: async (event, type, ids, extraData) => {
        try {
          this.info("NOTIFY", `event=${event} type=${type} ids=[${(ids || []).join(",")}]`);

          // -------------------------
          // COLLECTION events
          // -------------------------
          if (type === "collection") {
            if (event === "add") {
              for (const id of (ids || [])) await FS_CollectionsObserver.onAdd(this, id);
            } else if (event === "modify") {
              for (const id of (ids || [])) await FS_CollectionsObserver.onModify(this, id);
            } else if (event === "delete" || event === "trash") {
              for (const id of (ids || [])) await FS_CollectionsObserver.onDelete(this, id);
            } else {
              this.debug("NOTIFY", `ignored collection event=${event}`);
            }
            return;
          }

          // -------------------------
          // ITEM events
          // -------------------------
          if (type === "item") {
            if (typeof FS_ItemsObserver === "undefined") {
              this.warn("NOTIFY", "FS_ItemsObserver is undefined (did you load function/items/observer-items.js?)");
              return;
            }

            // 1) classificador (só faz sentido em trash/delete)
            if (event === "trash" || event === "delete") {
              await FS_ItemsObserver.onTrashOrDelete(this, event, ids);
            }

            // 2) ações específicas
            if (event === "trash") {
              for (const id of (ids || [])) await FS_ItemsObserver.onItemTrash(this, id);
              return;
            }

            if (event === "modify") {
              for (const id of (ids || [])) await FS_ItemsObserver.onItemModify(this, id);
              return;
            }

            if (event === "delete") {
              for (const id of (ids || [])) await FS_ItemsObserver.onItemDelete(this, id);
              return;
            }

            this.debug("NOTIFY", `ignored item event=${event}`);
            return;
          }

          // outros tipos (search, tag, etc.)
          this.debug("NOTIFY", `ignored type=${type} event=${event}`);
        } catch (e) {
          this.error("NOTIFY", String(e));
        }
      }
    };

    this._notifierID = Zotero.Notifier.registerObserver(
      observer,
      ["collection", "item"],
      "fs-mirror"
    );

    this.info("NOTIFY", `registered notifierID=${this._notifierID}`);
  };

  FS_Mirror._unregisterObservers = function () {
    if (!this._notifierID) return;
    Zotero.Notifier.unregisterObserver(this._notifierID);
    this.info("NOTIFY", `unregistered notifierID=${this._notifierID}`);
    this._notifierID = null;
  };
})();