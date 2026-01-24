/* functions/fs-mirror.js */

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

	// logging (file)
	_logFilePath: null,
	_logWriteChain: Promise.resolve(), // serializa writes
	_debug: true,

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.runID = Math.random().toString(36).slice(2, 8);
	},

	pref(key, global = true) {
		return Zotero.Prefs.get(`extensions.fs-mirror.${key}`, global);
	},

	// -----------------------------
	// Logging (Zotero + external file)
	// -----------------------------
	log(level, tag, msg) {
		// respeita debug para DEBUG (e opcionalmente para tudo, se você quiser no futuro)
		if (level === "DEBUG" && !this._debug) return;

		const line = `${_ts()} ${level} ${tag} ${msg}`;
		// 1) Zotero console
		Zotero.debug(`[FSMirror ${this.runID}] ${line}`);

		// 2) external file (best-effort, async, serialized)
		this._appendLogLine(line + "\n");
	},

	_appendLogLine(line) {
		if (!this._logFilePath) return;

		// serializa pra nunca intercalar bytes de writes concorrentes
		this._logWriteChain = this._logWriteChain.then(async () => {
			try {
				const encoder = new TextEncoder();
				const bytes = encoder.encode(line);

				// garante append sem reescrever arquivo inteiro
				const f = await OS.File.open(this._logFilePath, { write: true, append: true });
				try {
					await f.write(bytes);
				} finally {
					await f.close();
				}
			} catch (e) {
				// não deixa o logger derrubar o plugin
				Zotero.debug(`[FSMirror ${this.runID}] ${_ts()} ERROR LOGFILE ${String(e)}`);
			}
		});
	},

	async _initExternalLogging({ rootDir, dryRun }) {
		this._debug = !!this.pref("debug");

		// logsDir: se vazio -> rootDir/logs
		let logsDir = this.pref("logsDir");
		if (!logsDir) {
			logsDir = OS.Path.join(rootDir, "logs");
		}

		// cria diretório de logs
		await FSMirrorFS.ensureDir(logsDir, (m) => this.log("INFO", "FS", m), dryRun);

		const filename = `fs-mirror-${_dateStamp()}-${this.runID}.log`;
		this._logFilePath = OS.Path.join(logsDir, filename);

		// escreve cabeçalho (opcional, mas útil)
		this.log("INFO", "LOG", `external logfile="${this._logFilePath}"`);
		this.log("INFO", "LOG", `debug=${this._debug} dryRun=${!!dryRun}`);
	},

	// -----------------------------
	// Lifecycle
	// -----------------------------
	async start() {
		if (this.started) return;
		this.started = true;

		// lê config
		const rootDir = this.pref("rootDir");
		const dryRun = !!this.pref("dryRun");

		// init external logging (se rootDir existir)
		// OBS: sem rootDir, não tem default rootDir/logs. Então só loga no Zotero.
		if (rootDir) {
			await this._initExternalLogging({ rootDir, dryRun });
		} else {
			this._debug = !!this.pref("debug");
		}

		this.log("INFO", "START", `id=${this.id} version=${this.version}`);
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