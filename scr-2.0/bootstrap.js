/* global Zotero, OS */

async function startup() {
    Zotero.debug("FS-MIRROR-TEST STARTUP " + new Date().toISOString());
}

function shutdown() {
    Zotero.debug("FS-MIRROR-TEST SHUTDOWN " + new Date().toISOString());
}
