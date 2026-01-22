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

	async main() {
		this.log(`Loaded (id=${this.id}, version=${this.version})`);
		const rootDir = this.pref("rootDir");
		this.log(`rootDir=${rootDir ?? "(not set)"}`);

		// --- Notifier observer: começa simples ---
		if (this._notifierID) return;

		const observer = {
			notify: async (event, type, ids, extraData) => {
				try {
					// event: 'add' | 'modify' | 'delete' | 'move'...
					// type: 'item' (inclui attachments), 'collection', etc.
					FSMirror.log(`NOTIFY event=${event} type=${type} ids=[${ids.join(",")}]`);

					if (type !== "item") return;

					// Carrega os itens e filtra attachments
					const items = await Zotero.Items.getAsync(ids);
					for (const item of items) {
						if (!item) continue;

						if (item.isAttachment && item.isAttachment()) {
							const filename = item.getFilename?.() ?? "(no filename)";
							const title = item.getField?.("title") ?? "(no title)";
							FSMirror.log(`  ATTACHMENT id=${item.id} file=${filename} title=${title}`);
						} else {
							const title = item.getField?.("title") ?? "(no title)";
							FSMirror.log(`  ITEM id=${item.id} title=${title}`);
						}
					}
				} catch (e) {
					FSMirror.log("Notifier error: " + e);
				}
			},
		};

		// Observa só o tipo "item" (suficiente pra anexos)
		this._notifierID = Zotero.Notifier.registerObserver(observer, ["item"], "fs-mirroring");
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
	},
};