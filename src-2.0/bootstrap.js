/* global Zotero, Services */

var FSMirror;

function _log(msg) {
  Zotero.debug(`FSMirror/bootstrap: ${msg}`);
}

function install() {
  _log("install()");
}

async function startup({ id, version, rootURI }) {
  _log(`startup() id=${id} version=${version}`);

  // carrega módulos
  Services.scriptloader.loadSubScript(rootURI + "fs.js");
  Services.scriptloader.loadSubScript(rootURI + "mirror_collections.js");
  Services.scriptloader.loadSubScript(rootURI + "fsmirror.js");

  FSMirror.init({ id, version, rootURI });
  await FSMirror.start();
}

function onMainWindowLoad({ window }) {
  FSMirror?.onMainWindowLoad?.(window);
}

function onMainWindowUnload({ window }) {
  FSMirror?.onMainWindowUnload?.(window);
}

function shutdown() {
  _log("shutdown()");
  FSMirror?.stop?.();
  FSMirror = undefined;
}

function uninstall() {
  _log("uninstall()");
}