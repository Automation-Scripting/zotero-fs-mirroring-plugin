/*bootstrap.js */

var FSMirror;

function _log(msg) {
  Zotero.debug(`FSMirror/bootstrap: ${msg}`);
}

function install() {
  _log("install()");
}

async function startup({ id, version, rootURI }) {
  _log(`startup() id=${id} version=${version}`);

  Services.scriptloader.loadSubScript(rootURI + "functions/fs.js");
  Services.scriptloader.loadSubScript(rootURI + "functions/mirror_collections.js");
  Services.scriptloader.loadSubScript(rootURI + "functions/fsmirror.js");

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