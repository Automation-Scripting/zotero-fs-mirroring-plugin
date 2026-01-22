/* global Zotero, FSMirrorFS, FSMirrorCollections */

function _ts() {
	const d = new Date();
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
		`${pad(d.getMilliseconds(), 3)}`;
}

var FSMirror = {
	// metadata
	id: null,
	version: null,
	rootURI: null,

	// runtime
	runID: null,
	started: false,
	notifierID: null,

	// cache
	colPathCache: new Map(), // collectionID -> lastPath

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.runID = Math.random().toString(36).slice(2, 8);
	},

	log(level, tag, msg) {
		Zotero.debug(`[FSMirror ${this.runID}] ${_ts()} ${level} ${tag} ${msg}`);
	},

	pref(key, global = true) {
		return Zotero.Prefs.get(`extensions.fs-mirroring.${key}`, global);
	},

	async start() {
		if (this.started) return;
		this.started = true;

		this.log("INFO", "START", `id=${this.id} version=${this.version}`);

		const rootDir = this.pref("rootDir");
		const dryRun = !!this.pref("dryRun");

		this.log("INFO", "CFG", `rootDir=${rootDir || "(not set)"} dryRun=${dryRun}`);

		if (!rootDir) {
			this.log("WARN", "CFG", "rootDir not set; FS mirroring disabled");
			return;
		}

		await FSMirrorFS.ensureDir(rootDir, (m) => this.log("INFO", "FS", m), dryRun);

		this._registerNotifier();
	},

	stop() {
		this.log("INFO", "STOP", "stopping...");
		this._unregisterNotifier();
		this.started = false;
	},

	_registerNotifier() {
		if (this.notifierID) return;

		const observer = {
			notify: async (event, type, ids, extraData) => {
				// filtro: só o que queremos primeiro
				if (type !== "collection") return;

				try {
					await FSMirrorCollections.handle({
						api: FSMirror,
						fs: FSMirrorFS,
						event,
						ids,
						extraData
					});
				} catch (e) {
					FSMirror.log("ERROR", "NOTIFY", String(e));
				}
			}
		};

		this.notifierID = Zotero.Notifier.registerObserver(
			observer,
			["collection"],
			"fs-mirroring"
		);

		this.log("INFO", "NOTIFY", `registered notifierID=${this.notifierID}`);
	},

	_unregisterNotifier() {
		if (!this.notifierID) return;
		Zotero.Notifier.unregisterObserver(this.notifierID);
		this.log("INFO", "NOTIFY", `unregistered notifierID=${this.notifierID}`);
		this.notifierID = null;
	}
};