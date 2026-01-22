/* global Zotero, Services */

var FSMirror;

function log(msg) {
	Zotero.debug("FS Mirror: " + msg);
}

function install() {
	log("Installed");
}

async function startup({ id, version, rootURI }) {
	log(`Starting (v=${version})`);

	// (opcional) painel de preferências do plugin
	Zotero.PreferencePanes.register({
		pluginID: "fs-mirroring@chanah.dev",
		src: rootURI + "preferences.xhtml",
		scripts: [rootURI + "preferences.js"],
	});

	// Carrega o engine
	Services.scriptloader.loadSubScript(rootURI + "fs-mirror.js");

	// Inicializa e roda
	FSMirror.init({ id, version, rootURI });
	await FSMirror.main();
}

function shutdown() {
	log("Shutting down");

	try {
		// Se você implementar FSMirror.shutdown(), ele limpa observers/timers
		FSMirror?.shutdown?.();
	} catch (e) {
		log("Error during shutdown: " + e);
	}

	FSMirror = undefined;
}

function uninstall() {
	log("Uninstalled");
}