/** bootstrap.js */
var FS_Mirror;

function log(msg) {
	Zotero.debug("FS Mirror: " + msg);
}

function install() {
	log("Installed 2.0");
}

async function startup({ id, version, rootURI }) {
	log("Starting 2.0");

	Zotero.PreferencePanes.register({
		pluginID: 'fs-mirror@chanah.dev',
		src: rootURI + 'preferences.xhtml',
		scripts: [rootURI + 'preferences.js']
	});

	// no startup(), antes de registrar observer/menu:
	try {
		globalThis.addEventListener?.("unhandledrejection", (ev) => {
			Zotero.debug?.("[FS Mirror] UNHANDLED REJECTION: " + String(ev.reason));
		});
		globalThis.addEventListener?.("error", (ev) => {
			Zotero.debug?.("[FS Mirror] GLOBAL ERROR: " + String(ev.error || ev.message));
		});
	} catch { }
	
	Services.scriptloader.loadSubScript(rootURI + 'function/fs-mirror.js');
	Services.scriptloader.loadSubScript(rootURI + 'function/observer-collections.js');
	Services.scriptloader.loadSubScript(rootURI + "function/observer-items.js");
	Services.scriptloader.loadSubScript(rootURI + 'function/sanitize.js');
	FS_Mirror.init({ id, version, rootURI });

	await FS_Mirror.initLogger();
	FS_Mirror.addToAllWindows();
	await FS_Mirror.main();
}

function onMainWindowLoad({ window }) {
	FS_Mirror.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	FS_Mirror.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down 2.0");
	try { FS_Mirror._unregisterObservers(); } catch (e) { }
	FS_Mirror.removeFromAllWindows();
	FS_Mirror = undefined;
}

function uninstall() {
	log("Uninstalled 2.0");
}
