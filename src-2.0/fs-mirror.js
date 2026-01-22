/* global Zotero */

var FSMirror = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,

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
		// Convenção: extensions.fs-mirroring.<key>
		return Zotero.Prefs.get(`extensions.fs-mirroring.${key}`, global);
	},

	async main() {
		this.log(`Loaded (id=${this.id}, version=${this.version})`);

		// Exemplo: ler o diretório raiz (você vai definir isso nas prefs depois)
		const rootDir = this.pref("rootDir");
		this.log(`rootDir=${rootDir ?? "(not set)"}`);

		// TODO: aqui entra o engine:
		// - observar alterações na biblioteca/attachments
		// - espelhar estrutura no FS
		// - criar links/aliases conforme sua regra
	},

	shutdown() {
		// TODO: remover observers/timers quando você adicionar
		this.log("Shutdown");
	},
};