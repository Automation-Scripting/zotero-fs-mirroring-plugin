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

	// debug hooks globais
	try {
		globalThis.addEventListener?.("unhandledrejection", (ev) => {
			Zotero.debug?.("[FS Mirror] UNHANDLED REJECTION: " + String(ev.reason));
		});
		globalThis.addEventListener?.("error", (ev) => {
			Zotero.debug?.("[FS Mirror] GLOBAL ERROR: " + String(ev.error || ev.message));
		});
	} catch { }

	// ----------------------------
	// CORE (nova organização)
	// ----------------------------
	Services.scriptloader.loadSubScript(rootURI + "core/utils.js");
	Services.scriptloader.loadSubScript(rootURI + "core/fs-mirror.js");  // define FS_Mirror
	Services.scriptloader.loadSubScript(rootURI + "core/logging.js");   // injeta initLogger/info/etc
	Services.scriptloader.loadSubScript(rootURI + "core/notifier.js");  // injeta _registerObservers
	Services.scriptloader.loadSubScript(rootURI + "core/ui.js");        // injeta addToWindow/menu + handlers

	// ----------------------------
	// COMMON
	// ----------------------------
	Services.scriptloader.loadSubScript(rootURI + "function/common/path.js");
	Services.scriptloader.loadSubScript(rootURI + "function/common/io.js");
	Services.scriptloader.loadSubScript(rootURI + "function/common/api.js");
	Services.scriptloader.loadSubScript(rootURI + "function/common/cache.js");

	// ----------------------------
	// ITEMS
	// ----------------------------
	Services.scriptloader.loadSubScript(rootURI + "function/items/read.js");
	Services.scriptloader.loadSubScript(rootURI + "function/items/trash.js");
	Services.scriptloader.loadSubScript(rootURI + "function/items/update.js");
	Services.scriptloader.loadSubScript(rootURI + "function/items/delete.js");
	Services.scriptloader.loadSubScript(rootURI + "function/items/index.js");
	Services.scriptloader.loadSubScript(rootURI + "function/items/create.js");
	Services.scriptloader.loadSubScript(rootURI + "function/items/observer-items.js");

	// ----------------------------
	// COLLECTION-ITEMS
	// ----------------------------
	Services.scriptloader.loadSubScript(rootURI + "function/collection-items/observer-collection-items.js");

	// ----------------------------
	// COLLECTIONS
	// ----------------------------
	Services.scriptloader.loadSubScript(rootURI + "function/collections/read.js");
	Services.scriptloader.loadSubScript(rootURI + "function/collections/create.js");
	Services.scriptloader.loadSubScript(rootURI + "function/collections/update.js");
	Services.scriptloader.loadSubScript(rootURI + "function/collections/delete.js");
	Services.scriptloader.loadSubScript(rootURI + "function/collections/index.js");
	Services.scriptloader.loadSubScript(rootURI + "function/collections/observer-collections.js");

	// ----------------------------
	// SANITIZE (atenção ao nome da pasta)
	// ----------------------------
	Services.scriptloader.loadSubScript(rootURI + "function/sanatize/sanitize.js");

	// init + start
	FS_Mirror.init({ id, version, rootURI });

	await FS_Mirror.initLogger();

	// Pode continuar chamando isso aqui (é “startup/UI bootstrap”)
	FS_Mirror.addToAllWindows();

	await FS_Mirror.main();
}

// ✅ assinatura obrigatória, implementação delegada ao core/ui.js
function onMainWindowLoad({ window }) {
	try {
		FS_Mirror.onMainWindowLoad?.({ window });
	} catch (e) { }
}

// ✅ assinatura obrigatória, implementação delegada ao core/ui.js
function onMainWindowUnload({ window }) {
	try {
		FS_Mirror.onMainWindowUnload?.({ window });
	} catch (e) { }
}

function shutdown() {
	log("Shutting down 2.0");
	try { FS_Mirror.shutdown?.(); } catch (e) { } // <-- opcional, se você implementar no core
	try { FS_Mirror._unregisterObservers?.(); } catch (e) { }
	try { FS_Mirror.removeFromAllWindows?.(); } catch (e) { }
	FS_Mirror = undefined;
}

function uninstall() {
	log("Uninstalled 2.0");
}