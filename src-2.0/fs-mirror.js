/* global Zotero */

var FSMirror = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,

	_notifierID: null,

	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},

	log(msg) {
		Zotero.debug("FS Mirror: " + msg);
	},

	pref(key, global = true) {
		return Zotero.Prefs.get(`extensions.fs-mirroring.${key}`, global);
	},

	// -------- helpers --------

	_fmtIds(ids) {
		try { return "[" + (ids || []).join(",") + "]"; }
		catch { return "[?]"; }
	},

	async _describeItem(id) {
		const item = await Zotero.Items.getAsync(id);
		if (!item) return `item#${id} (missing)`;

		const isAtt = item.isAttachment && item.isAttachment();
		const itemType = isAtt ? "attachment" : "item";
		const title = item.getField?.("title") ?? "";
		const key = item.key ?? "";
		const parentID = isAtt ? (item.parentItemID ?? null) : null;

		let filename = "";
		if (isAtt) {
			filename = item.getFilename?.() ?? "";
		}

		// coleções onde o item está
		let colls = [];
		try {
			colls = item.getCollections?.() ?? [];
		} catch { }

		return `${itemType}#${id} key=${key} title="${title}"` +
			(filename ? ` file="${filename}"` : "") +
			(parentID ? ` parent=${parentID}` : "") +
			(colls.length ? ` collections=${JSON.stringify(colls)}` : "");
	},

	async _describeCollection(id) {
		const c = await Zotero.Collections.getAsync(id);
		if (!c) return `collection#${id} (missing)`;
		const key = c.key ?? "";
		const name = c.name ?? "";
		const parentID = c.parentID ?? null;
		return `collection#${id} key=${key} name="${name}"` + (parentID ? ` parent=${parentID}` : "");
	},

	async _describeTag(id) {
		// Tags API pode variar; faz best-effort
		try {
			const t = await Zotero.Tags.getAsync(id);
			if (!t) return `tag#${id} (missing)`;
			const name = t.tag ?? t.name ?? "";
			return `tag#${id} "${name}"`;
		} catch {
			return `tag#${id}`;
		}
	},

	async _logExtraData(extraData) {
		if (!extraData) return;
		try {
			// ExtraData às vezes é objeto grande; loga só chaves
			const keys = Object.keys(extraData);
			if (keys.length) this.log(`  extraData keys=${JSON.stringify(keys)}`);
		} catch { }
	},

	// -------- main --------

	async main() {
		this.log(`Loaded (id=${this.id}, version=${this.version})`);
		const rootDir = this.pref("rootDir");
		this.log(`rootDir=${rootDir ?? "(not set)"}`);

		if (this._notifierID) {
			this.log("Notifier already registered");
			return;
		}

		const observer = {
			notify: async (event, type, ids, extraData) => {
				try {
					// Linha “macro” (sempre)
					FSMirror.log(`NOTIFY event=${event} type=${type} ids=${FSMirror._fmtIds(ids)}`);

					await FSMirror._logExtraData(extraData);

					// Detalhe por tipo
					if (type === "item") {
						for (const id of ids) {
							FSMirror.log("  " + await FSMirror._describeItem(id));
						}
					}
					else if (type === "collection") {
						for (const id of ids) {
							FSMirror.log("  " + await FSMirror._describeCollection(id));
						}
					}
					else if (type === "collection-item") {
						// Relação item<->collection mudou (o “move de pasta” geralmente cai aqui)
						// ids aqui podem ser ids de collectionItem rows (depende), então logamos bruto
						FSMirror.log("  (collection-item change; see extraData if present)");
						// Tenta interpretar extraData se tiver itemIDs/collectionID
						try {
							if (extraData) {
								const maybe = extraData[ids?.[0]];
								if (maybe) FSMirror.log("  extraData[0]=" + JSON.stringify(maybe));
							}
						} catch { }
					}
					else if (type === "tag") {
						for (const id of ids) {
							FSMirror.log("  " + await FSMirror._describeTag(id));
						}
					}
					else {
						// Outros tipos possíveis: 'search', 'feed', etc
						// Deixa macro-line só
					}
				} catch (e) {
					FSMirror.log("Notifier error: " + e);
				}
			}
		};

		// 👇 lista ampla de tipos para “logar tudo”
		const types = ["item", "collection", "collection-item", "tag"];

		this._notifierID = Zotero.Notifier.registerObserver(observer, types, "fs-mirroring");
		this.log("Notifier registered: " + this._notifierID);
	},

	shutdown() {
		try {
			if (this._notifierID) {
				Zotero.Notifier.unregisterObserver(this._notifierID);
				this.log("Notifier unregistered: " + this._notifierID);
				this._notifierID = null;
			}
		} catch (e) {
			this.log("Shutdown error: " + e);
		}
		this.log("Shutdown");
	}
};