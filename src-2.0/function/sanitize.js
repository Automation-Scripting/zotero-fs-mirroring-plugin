// function/sanitize.js
//
// Read-only sanitizer scan, scoped to ONE collection:
// - Lists items in selected collection (optionally recursive later)
// - For each item: PDF attachments
// - Classifies attachment as LINKED vs STORED (storage/XXXXXX)
// - Logs: real path, computed target folder, planned filename/path
//
// No filesystem writes. No Zotero writes.

var FS_Sanitize = {
  // -------------------------
  // helpers
  // -------------------------
  _sanitizeName(name) {
    return (name || "Untitled")
      .replace(/[\/\\:\*\?"<>\|]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  async _collectionChainByID(collectionID) {
    const chain = [];
    let cur = await Zotero.Collections.getAsync(collectionID);
    while (cur) {
      chain.push({ id: cur.id, key: cur.key, name: cur.name, parentID: cur.parentID });
      cur = cur.parentID ? await Zotero.Collections.getAsync(cur.parentID) : null;
    }
    return chain.reverse();
  },

  _collectionDesiredPath(rootDir, chain) {
    const segs = chain.map(x => `${this._sanitizeName(x.name)} [${x.key}]`);
    return [rootDir, ...segs].join("/").replace(/\/+/g, "/");
  },

  _plannedPDFName(parentItem, att) {
    const title = this._sanitizeName(parentItem.getField("title"));
    const year = (parentItem.getField("date") || "").match(/\b(19|20)\d{2}\b/)?.[0] || "";
    const base = year ? `${title} - ${year}` : title;
    return `${base} [${att.key}].pdf`.replace(/\s+/g, " ").trim();
  },

  _classifyAttachmentPath(path) {
    if (!path) return { kind: "MISSING", reason: "no path" };
    const p = String(path).replace(/\\/g, "/");
    if (p.includes("/storage/")) return { kind: "STORED", reason: "path contains /storage/" };
    if (p.startsWith("/")) return { kind: "LINKED", reason: "absolute path" };
    return { kind: "UNKNOWN", reason: "non-absolute path" };
  },

  async _getSelectedCollection(window) {
    // ZoteroPane API varies; try a few safe options
    const zp = window.ZoteroPane;
    if (!zp) return null;

    // Common in many versions:
    if (typeof zp.getSelectedCollection === "function") return zp.getSelectedCollection();

    // Fallback: selected collection in collectionTreeRow (less ideal)
    // If this doesn’t exist in your build, we’ll log and bail.
    const cv = zp.getCollectionTreeRow?.();
    if (cv?.ref && cv.ref.isCollection?.()) return cv.ref;
    return null;
  },

  // -------------------------
  // main API
  // -------------------------
  async scanSelectedCollection({ api, window } = {}) {
    const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true) || "";
    const col = await this._getSelectedCollection(window);

    if (!col) {
      api.error("SAN", "no selected collection (scan aborted)");
      return;
    }

    api.info("SAN", `scan collection start id=${col.id} key=${col.key} name="${col.name}" rootDir="${rootDir || "(not set)"}"`);

    const chain = await this._collectionChainByID(col.id);
    const chainStr = chain.map(x => `${x.name}(${x.key})`).join(" > ");
    const plannedFolder = rootDir ? this._collectionDesiredPath(rootDir, chain) : null;

    api.info("SAN", `  col chain: ${chainStr}`);
    api.info("SAN", `  col folder (planned): "${plannedFolder || "(no rootDir)"}"`);

    // Items IN THIS COLLECTION (not full library)
    // getChildItems returns itemIDs of items assigned to the collection
    let itemIDs = [];
    try {
      itemIDs = col.getChildItems(true); // true = include subcollections? (depends) / often means "include items from subcollections"
      // If that behavior is not what we want, we switch to false later.
    } catch (e) {
      // Some Zotero builds use getChildItemsAsync
      try {
        itemIDs = await col.getChildItemsAsync(true);
      } catch (e2) {
        api.error("SAN", `cannot get items for collection: ${String(e2)}`);
        return;
      }
    }

    // Deduplicate just in case
    itemIDs = [...new Set(itemIDs)];

    api.info("SAN", `  items in scope: ${itemIDs.length}`);

    let scannedItems = 0;
    let pdfCount = 0;

    for (const id of itemIDs) {
      const item = await Zotero.Items.getAsync(id);
      if (!item) continue;

      // skip attachments/notes as top-level
      if (item.isAttachment() || item.isNote() || item.isAnnotation?.()) continue;

      scannedItems++;

      const title = this._sanitizeName(item.getField("title"));
      api.info("SAN", `item id=${id} key=${item.key} title="${title}"`);

      const attIDs = item.getAttachments ? item.getAttachments() : [];
      if (!attIDs.length) continue;

      for (const attID of attIDs) {
        const att = await Zotero.Items.getAsync(attID);
        if (!att || !att.isAttachment()) continue;

        const ct = att.attachmentContentType || att.getField?.("contentType") || "";
        if (ct !== "application/pdf") continue;

        pdfCount++;

        let path = "";
        try { path = await att.getFilePathAsync(); } catch (e) { path = ""; }

        const cls = this._classifyAttachmentPath(path);
        const plannedName = this._plannedPDFName(item, att);
        const plannedPath = plannedFolder ? `${plannedFolder}/${plannedName}`.replace(/\/+/g, "/") : null;

        api.info("SAN", `  pdf att id=${attID} key=${att.key} kind=${cls.kind} (${cls.reason})`);
        api.info("SAN", `    zoteroPath="${path || "(missing)"}"`);
        api.info("SAN", `    plannedPath="${plannedPath || "(no planned folder)"}"`);

        if (cls.kind === "STORED") {
          api.warn("SAN", `    candidate: STORED -> would externalize+relink (future)`);
        } else if (cls.kind === "LINKED") {
          const underRoot = rootDir && path && String(path).startsWith(rootDir);
          api.info("SAN", `    check: linkedUnderRoot=${!!underRoot}`);
        } else if (cls.kind === "MISSING") {
          api.warn("SAN", `    candidate: missing file`);
        } else {
          api.warn("SAN", `    candidate: UNKNOWN path format`);
        }
      }
    }

    api.info("SAN", `scan collection done itemsScanned=${scannedItems} pdfAttachments=${pdfCount}`);
  }
};