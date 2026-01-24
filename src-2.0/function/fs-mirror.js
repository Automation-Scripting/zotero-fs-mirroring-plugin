/** fs-mirror.js */

var IOUtils = globalThis.IOUtils;
var PathUtils = globalThis.PathUtils;

function _ts() {
	const d = new Date();
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
		`${pad(d.getMilliseconds(), 3)}`;
}

function _dateStamp() {
	const d = new Date();
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// join simples (não depende de OS.Path)
function _joinPath(...parts) {
	return parts.join("/").replace(/\/+/g, "/");
}

// ---------- External logging helpers (top of file) ----------

FS_Mirror = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	addedElementIDs: [],
	colPathCache: new Map(),

	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},

	// -----------------------------
	// External logger (IOUtils) + Zotero.debug
	// -----------------------------
	_logFilePath: null,
	_logWriteChain: Promise.resolve(),
	_runID: null,
	_debug: true,
	_echoToZotero: true,

	async initLogger() {
		this._debug = !!Zotero.Prefs.get("extensions.fs-mirror.debug", true);
		this._echoToZotero = !!Zotero.Prefs.get("extensions.fs-mirror.echoToZotero", true);

		let logsDir = Zotero.Prefs.get("extensions.fs-mirror.logsDir", true);

		// fallback: usa rootDir/logs se logsDir não setado (bem intuitivo pro seu plugin)
		if (!logsDir) {
			const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true);
			logsDir = rootDir ? _joinPath(rootDir, "logs") : null;
		}
		// último fallback: home/FSMirror/logs
		if (!logsDir) {
			logsDir = _joinPath(PathUtils?.homeDir || "", "FSMirror", "logs");
		}

		// cria diretório (recursive)
		try {
			await IOUtils.makeDirectory(logsDir, { createAncestors: true });
		} catch (e) {
			Zotero.debug(`[FS Mirror] ${_ts()} WARN cannot create logsDir="${logsDir}": ${String(e)}`);
			this._logFilePath = null;
			return;
		}

		this._runID = Math.random().toString(36).slice(2, 8);
		const fileName = `fs-mirror-${_dateStamp()}-${this._runID}.log`;
		this._logFilePath = _joinPath(logsDir, fileName);

		// garante que o arquivo existe (touch controlado)
		try {
			if (!(await IOUtils.exists(this._logFilePath))) {
				await IOUtils.write(this._logFilePath, new Uint8Array());
			}
		} catch (e) {
			Zotero.debug(`[FS Mirror] ${_ts()} WARN cannot create logfile="${this._logFilePath}": ${String(e)}`);
			this._logFilePath = null;
			return;
		}

		this.info("LOG", `external logfile="${this._logFilePath}"`);
		this.info("LOG", `debug=${this._debug} echoToZotero=${this._echoToZotero}`);
	},

	_appendLogLine(line) {
		if (!this._logFilePath) return;

		this._logWriteChain = this._logWriteChain.then(async () => {
			try {
				const enc = new TextEncoder();
				const bytes = enc.encode(line);

				// Se o arquivo ainda não existe, cria com write (sem append)
				if (!(await IOUtils.exists(this._logFilePath))) {
					await IOUtils.write(this._logFilePath, bytes);
					return;
				}

				// Se existe, faz append com leitura+concat+write (universal)
				const prev = await IOUtils.read(this._logFilePath);
				const next = new Uint8Array(prev.length + bytes.length);
				next.set(prev, 0);
				next.set(bytes, prev.length);
				await IOUtils.write(this._logFilePath, next);
			} catch (e) {
				Zotero.debug(`[FS Mirror] ${_ts()} ERROR write logfile: ${String(e)}`);
			}
		});
	},

	_emit(level, tag, msg) {
		if (level === "DEBUG" && !this._debug) return;

		const line = `${_ts()} ${level} ${tag} ${msg}`;
		if (this._echoToZotero) {
			Zotero.debug(`[FS Mirror] ${line}`);
		}
		this._appendLogLine(line + "\n");
	},

	debug(tag, msg) { this._emit("DEBUG", tag, msg); },
	info(tag, msg) { this._emit("INFO", tag, msg); },
	warn(tag, msg) { this._emit("WARN", tag, msg); },
	error(tag, msg) { this._emit("ERROR", tag, msg); },

	// compat
	log(msg) { this.info("APP", msg); },

	addToWindow(window) {
		let doc = window.document;

		// Add a stylesheet to the main Zotero pane
		let link1 = doc.createElement('link');
		link1.id = 'make-it-red-stylesheet';
		link1.type = 'text/css';
		link1.rel = 'stylesheet';
		link1.href = this.rootURI + 'style.css';
		doc.documentElement.appendChild(link1);
		this.storeAddedElement(link1);
		this._addCollectionContextMenu(window);

		// Use Fluent for localization
		window.MozXULElement.insertFTLIfNeeded("make-it-red.ftl");

		// Add menu option
		let menuitem = doc.createXULElement('menuitem');
		menuitem.id = 'make-it-green-instead';
		menuitem.setAttribute('type', 'checkbox');
		menuitem.setAttribute('data-l10n-id', 'make-it-red-green-instead');
		// MozMenuItem#checked is available in Zotero 7
		menuitem.addEventListener('command', () => {
			FS_Mirror.toggleGreen(window, menuitem.checked);
		});
		doc.getElementById('menu_viewPopup').appendChild(menuitem);
		this.storeAddedElement(menuitem);
	},

	addToAllWindows() {
		var windows = Zotero.getMainWindows();
		for (let win of windows) {
			if (!win.ZoteroPane) continue;
			this.addToWindow(win);
		}
	},

	storeAddedElement(elem) {
		if (!elem.id) {
			throw new Error("Element must have an id");
		}
		this.addedElementIDs.push(elem.id);
	},

	removeFromWindow(window) {
		var doc = window.document;
		// Remove all elements added to DOM
		for (let id of this.addedElementIDs) {
			doc.getElementById(id)?.remove();
		}
		doc.querySelector('[href="make-it-red.ftl"]')?.remove();
	},

	removeFromAllWindows() {
		var windows = Zotero.getMainWindows();
		for (let win of windows) {
			if (!win.ZoteroPane) continue;
			this.removeFromWindow(win);
		}
	},

	toggleGreen(window, enabled) {
		window.document.documentElement
			.toggleAttribute('data-green-instead', enabled);
	},

	async main() {

		this._registerObservers();
		this.info("MAIN", "observers registered (dry mode)");

		// Global properties are included automatically in Zotero 7
		var host = new URL('https://foo.com/path').host;
		this.log(`Host is ${host}`);

		// Retrieve a global pref
		this.log(`[Preferences] Root dir: ${Zotero.Prefs.get('extensions.fs-mirror.rootDir', true)}`);
		this.log(`[Preferences] Logs dir: ${Zotero.Prefs.get('extensions.fs-mirror.logsDir', true)}`);
		this.log(`[Preferences] Trash folder: ${Zotero.Prefs.get('extensions.fs-mirror.safeTrashDirName', true)}`);
		this.log(`[Preferences] Debug mode: ${Zotero.Prefs.get('extensions.fs-mirror.debug', true)}`);
		this.log(`[Preferences] Internal logs: ${Zotero.Prefs.get('extensions.fs-mirror.echoToZotero', true)}`);
		this.info("MAIN", "logger ready (if logfile path exists, it will be written)");
	},

	_notifierID: null,

	_registerObservers() {
		if (this._notifierID) return;

		const observer = {
			notify: async (event, type, ids, extraData) => {
				// Só coleções por enquanto
				if (type !== "collection") return;

				try {
					this.info("NOTIFY", `event=${event} type=${type} ids=[${(ids || []).join(",")}]`);

					if (event === "add") {
						for (const id of (ids || [])) {
							await FS_CollectionsObserver.onAdd(this, id);
						}
					} else if (event === "modify") {
						for (const id of (ids || [])) {
							await FS_CollectionsObserver.onModify(this, id);
						}
					} else if (event === "delete" || event === "trash") {
						for (const id of (ids || [])) {
							await FS_CollectionsObserver.onDelete(this, id);
						}
					} else {
						this.debug("NOTIFY", `ignored event=${event} type=${type}`);
					}
				} catch (e) {
					this.error("NOTIFY", String(e));
				}
			}
		};

		this._notifierID = Zotero.Notifier.registerObserver(
			observer,
			["collection"],
			"fs-mirror"
		);

		this.info("NOTIFY", `registered notifierID=${this._notifierID}`);
	},

	_unregisterObservers() {
		if (!this._notifierID) return;
		Zotero.Notifier.unregisterObserver(this._notifierID);
		this.info("NOTIFY", `unregistered notifierID=${this._notifierID}`);
		this._notifierID = null;
	},
	// --- Context menu helpers (Collection Tree) ---

	_findCollectionContextPopup(window) {
		const doc = window.document;

		// Strategy: pick the menupopup that contains "New Subcollection..." and "Rename Collection"
		for (const popup of doc.querySelectorAll("menupopup")) {
			// Some popups may not be connected yet
			const items = popup.querySelectorAll("menuitem");
			if (!items || !items.length) continue;

			let hasNewSub = false;
			let hasRename = false;

			for (const mi of items) {
				const label = (mi.getAttribute("label") || "").toLowerCase();
				const l10nId = (mi.getAttribute("data-l10n-id") || "").toLowerCase();

				// We accept either hard labels or l10n ids
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
	},

	_addCollectionContextMenu(window) {
		const doc = window.document;
		const popup = this._findCollectionContextPopup(window);
		if (!popup) return;

		// Avoid duplicate insertion if addToWindow runs twice
		if (doc.getElementById("fs-mirror-ctx-collection-root")) return;

		const sep = doc.createXULElement("menuseparator");
		sep.id = "fs-mirror-ctx-collection-sep";

		const mi = doc.createXULElement("menuitem");
		mi.id = "fs-mirror-ctx-collection-root";
		mi.setAttribute("label", "FS Mirror: Open root folder");
		mi.addEventListener("command", async () => {
			try {
				const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true);
				if (!rootDir) return this.warn("UI", "rootDir not set");

				// Open folder in OS file manager (Zotero helper exists in Zotero)
				// If this fails on your build, we can swap to an nsIFile + reveal()
				Zotero.File.reveal(rootDir);

				this.info("UI", `open rootDir "${rootDir}"`);
			} catch (e) {
				this.error("UI", `open rootDir failed: ${String(e)}`);
			}
		});

		popup.appendChild(sep);
		popup.appendChild(mi);

		this.storeAddedElement(sep);
		this.storeAddedElement(mi);

		this.info("UI", "collection context menu installed");
	}
}
