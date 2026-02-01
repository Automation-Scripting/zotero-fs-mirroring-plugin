// core/ui.js

(function () {
  // -----------------------------
  // Window UI injection
  // -----------------------------
  FS_Mirror.addToWindow = function (window) {
    let doc = window.document;

    // Add a stylesheet to the main Zotero pane
    let link1 = doc.createElement("link");
    link1.id = "make-it-red-stylesheet";
    link1.type = "text/css";
    link1.rel = "stylesheet";
    link1.href = this.rootURI + "style.css";
    doc.documentElement.appendChild(link1);
    this.storeAddedElement(link1);

    try {
      this._addCollectionContextMenu(window);
      this.info("UI", "collection context menu items injected");
    } catch (e) {
      this.error("UI", "failed to inject collection context menu: " + String(e));
    }

    // Use Fluent for localization
    window.MozXULElement.insertFTLIfNeeded("make-it-red.ftl");

    // Add menu option
    let menuitem = doc.createXULElement("menuitem");
    menuitem.id = "make-it-green-instead";
    menuitem.setAttribute("type", "checkbox");
    menuitem.setAttribute("data-l10n-id", "make-it-red-green-instead");
    menuitem.addEventListener("command", () => {
      FS_Mirror.toggleGreen(window, menuitem.checked);
    });
    doc.getElementById("menu_viewPopup").appendChild(menuitem);
    this.storeAddedElement(menuitem);
  };

  FS_Mirror.addToAllWindows = function () {
    var windows = Zotero.getMainWindows();
    for (let win of windows) {
      if (!win.ZoteroPane) continue;
      this.addToWindow(win);
    }
  };

  FS_Mirror.storeAddedElement = function (elem) {
    if (!elem.id) throw new Error("Element must have an id");
    this.addedElementIDs.push(elem.id);
  };

  FS_Mirror.removeFromWindow = function (window) {
    var doc = window.document;
    for (let id of this.addedElementIDs) {
      doc.getElementById(id)?.remove();
    }
    doc.querySelector('[href="make-it-red.ftl"]')?.remove();
  };

  FS_Mirror.removeFromAllWindows = function () {
    var windows = Zotero.getMainWindows();
    for (let win of windows) {
      if (!win.ZoteroPane) continue;
      this.removeFromWindow(win);
    }
  };

  // -----------------------------
  // Context menu helpers (Collection Tree)
  // -----------------------------
  FS_Mirror._findCollectionContextPopup = function (window) {
    const doc = window.document;

    for (const popup of doc.querySelectorAll("menupopup")) {
      const items = popup.querySelectorAll("menuitem");
      if (!items || !items.length) continue;

      let hasNewSub = false;
      let hasRename = false;

      for (const mi of items) {
        const label = (mi.getAttribute("label") || "").toLowerCase();
        const l10nId = (mi.getAttribute("data-l10n-id") || "").toLowerCase();

        if (label.includes("new subcollection") || l10nId.includes("new-subcollection")) hasNewSub = true;
        if (label.includes("rename collection") || l10nId.includes("rename-collection")) hasRename = true;

        if (hasNewSub && hasRename) break;
      }

      if (hasNewSub && hasRename) {
        this.debug("UI", `found collection context menupopup id="${popup.id || "(no id)"}"`);
        return popup;
      }
    }

    this.warn("UI", "collection context menupopup not found");
    return null;
  };

  FS_Mirror._addCollectionContextMenu = function (window) {
    const doc = window.document;
    const popup = this._findCollectionContextPopup(window);
    if (!popup) return;

    // ---------- Sanitize ----------
    let miScan = doc.getElementById("fs-mirror-ctx-sanitize-scan");
    if (!miScan) {
      miScan = doc.createXULElement("menuitem");
      miScan.id = "fs-mirror-ctx-sanitize-scan";
      miScan.setAttribute("label", "FS Mirror: Sanitize this collection");

      miScan.addEventListener("command", async () => {
        try {
          this.info("UI", "sanitize scan triggered (selected collection)");

          if (typeof FS_Sanitize === "undefined") {
            this.error("UI", "FS_Sanitize is undefined (did you load function/sanatize/sanitize.js?)");
            return;
          }

          await FS_Sanitize.scanSelectedCollection({ api: this, window });
        } catch (e) {
          this.error("UI", `sanitize scan failed: ${String(e)}`);
        }
      });

      popup.appendChild(miScan);
      this.storeAddedElement(miScan);
      this.info("UI", "menu item injected: sanitize");
    } else {
      this.debug("UI", "menu item exists: sanitize");
    }

    // ---------- Separator ----------
    let sep = doc.getElementById("fs-mirror-ctx-collection-sep");
    if (!sep) {
      sep = doc.createXULElement("menuseparator");
      sep.id = "fs-mirror-ctx-collection-sep";
      popup.appendChild(sep);
      this.storeAddedElement(sep);
      this.info("UI", "menu item injected: separator");
    } else {
      this.debug("UI", "menu item exists: separator");
    }

    // ---------- Open root ----------
    let mi = doc.getElementById("fs-mirror-ctx-collection-root");
    if (!mi) {
      mi = doc.createXULElement("menuitem");
      mi.id = "fs-mirror-ctx-collection-root";
      mi.setAttribute("label", "FS Mirror: Open root folder");

      mi.addEventListener("command", async () => {
        try {
          const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true);
          if (!rootDir) return this.warn("UI", "rootDir not set");

          Zotero.File.reveal(rootDir);
          this.info("UI", `open rootDir "${rootDir}"`);
        } catch (e) {
          this.error("UI", `open rootDir failed: ${String(e)}`);
        }
      });

      popup.appendChild(mi);
      this.storeAddedElement(mi);
      this.info("UI", "menu item injected: open-root");
    } else {
      this.debug("UI", "menu item exists: open-root");
    }

    this.info("UI", "collection context menu installed");
  };
})();

/** core/ui.js */

// Handlers chamados pelo bootstrap (assinaturas do Zotero ficam no bootstrap)
FS_Mirror.onMainWindowLoad = function ({ window }) {
	// garante que só mexe em janelas “main”
	try {
		if (!window || !window.ZoteroPane) return;
	} catch { }

	this.addToWindow(window);
};

FS_Mirror.onMainWindowUnload = function ({ window }) {
	try {
		if (!window || !window.ZoteroPane) return;
	} catch { }

	this.removeFromWindow(window);
};