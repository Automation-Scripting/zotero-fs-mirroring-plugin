/* global Zotero, OS, PathUtils */

const EXT_ID = "fs-collections-sync@chanah";

// Preferência: pasta raiz no FS (ex.: iCloud Drive/Zotero)
const PREF_ROOT = "extensions.fsCollectionsSync.rootPath";

// Onde guardamos o mapa collectionID -> fsPath (para saber o path antigo em renames/moves)
let stateFilePath = null;
let state = { collections: {} }; // { [collectionID]: "/abs/path/to/folder" }

function log(msg) {
    Zotero.debug(`[FSCollectionsSync] ${msg}`);
}

function sanitizeName(name) {
    // Remover caracteres proibidos em path (macOS/Windows)
    // Ajuste fino se quiser preservar mais coisas.
    return name
        .replace(/[\/\\:\*\?"<>\|]/g, " - ")
        .replace(/\s+/g, " ")
        .trim();
}

async function ensureDir(path) {
    await OS.File.makeDir(path, { ignoreExisting: true });
}

async function moveDir(from, to) {
    // OS.File.move funciona p/ arquivos e dirs no Zotero/Firefox runtime
    await OS.File.move(from, to);
}

async function exists(path) {
    try {
        return await OS.File.exists(path);
    } catch (e) {
        return false;
    }
}

async function loadState() {
    try {
        if (await exists(stateFilePath)) {
            let bytes = await OS.File.read(stateFilePath);
            let txt = new TextDecoder().decode(bytes);
            state = JSON.parse(txt);
            if (!state.collections) state.collections = {};
        }
    } catch (e) {
        log(`Failed to load state: ${e}`);
        state = { collections: {} };
    }
}

async function saveState() {
    try {
        let txt = JSON.stringify(state, null, 2);
        let bytes = new TextEncoder().encode(txt);
        await OS.File.writeAtomic(stateFilePath, bytes, { tmpPath: stateFilePath + ".tmp" });
    } catch (e) {
        log(`Failed to save state: ${e}`);
    }
}

function getRootPath() {
    // Se não estiver setado, o plugin não faz nada (modo seguro)
    return Zotero.Prefs.get(PREF_ROOT, true);
}

function getCollectionChain(collection) {
    // Retorna array do topo -> coleção atual
    let chain = [];
    let cur = collection;
    while (cur) {
        chain.unshift(cur);
        cur = cur.parentID ? Zotero.Collections.get(cur.parentID) : null;
    }
    return chain;
}

function computeCollectionFSPath(collection) {
    const root = getRootPath();
    if (!root) return null;

    const chain = getCollectionChain(collection);
    const parts = chain.map(c => sanitizeName(c.name));
    return PathUtils.join(root, ...parts);
}

async function syncCollectionFolder(collectionID) {
    const root = getRootPath();
    if (!root) return;

    const col = Zotero.Collections.get(collectionID);
    if (!col) return;

    const newPath = computeCollectionFSPath(col);
    if (!newPath) return;

    const oldPath = state.collections[String(collectionID)] || null;

    // Se não existia no state ainda: criar
    if (!oldPath) {
        await ensureDir(newPath);
        state.collections[String(collectionID)] = newPath;
        await saveState();
        log(`Created folder for collection ${collectionID}: ${newPath}`);
        return;
    }

    // Se path mudou (rename ou move/hierarquia)
    if (oldPath !== newPath) {
        // Garanta que pai existe
        const parentDir = PathUtils.parent(newPath);
        await ensureDir(parentDir);

        // Se a pasta antiga não existe mais, cria nova e atualiza state (não explode)
        if (!(await exists(oldPath))) {
            await ensureDir(newPath);
            state.collections[String(collectionID)] = newPath;
            await saveState();
            log(`Old folder missing; created new folder: ${newPath}`);
            return;
        }

        // Se destino já existe, não sobrescreve — cria sufixo para evitar desastre
        let target = newPath;
        if (await exists(target)) {
            target = newPath + " (conflict)";
            await ensureDir(target);
            log(`Conflict: target exists, moved into: ${target}`);
        }

        await moveDir(oldPath, target);
        state.collections[String(collectionID)] = target;
        await saveState();
        log(`Moved/renamed folder: ${oldPath} -> ${target}`);
    }
}

async function onCollectionDeleted(collectionID) {
    // Política segura: não apaga nada do FS automaticamente.
    // Só remove do state. (Você pode mover para _trash, se quiser.)
    delete state.collections[String(collectionID)];
    await saveState();
    log(`Collection deleted (state only): ${collectionID}`);
}

// Observador de eventos do Zotero
let notifierID = null;

const observer = {
    notify: async function (event, type, ids, extraData) {
        try {
            if (type === "collection") {
                if (event === "add" || event === "modify") {
                    for (let id of ids) {
                        await syncCollectionFolder(id);
                    }
                } else if (event === "delete") {
                    for (let id of ids) {
                        await onCollectionDeleted(id);
                    }
                }
            }

            // (Opcional) Você pode também observar itens/attachments aqui,
            // para mover PDFs linkados para dentro da pasta da coleção "home".
            //
            // if (type === "item" && (event === "add" || event === "modify")) { ... }

        } catch (e) {
            log(`Observer error: ${e}`);
        }
    }
};

async function init() {
    // Descobrir profile dir do Zotero e salvar state lá
    const profileDir = Zotero.Profile.dir;
    stateFilePath = PathUtils.join(profileDir, "fs-collections-sync-state.json");

    await loadState();

    // Registrar observador
    notifierID = Zotero.Notifier.registerObserver(observer, ["collection"], EXT_ID);

    log("Initialized. Set root path in prefs: " + PREF_ROOT);
}

function shutdown() {
    if (notifierID) {
        Zotero.Notifier.unregisterObserver(notifierID);
        notifierID = null;
    }
    log("Shutdown.");
}

// Hooks do bootstrap (Zotero/Firefox-style)
var EXPORTED_SYMBOLS = ["startup", "shutdown", "install", "uninstall"];

async function startup(data, reason) {
    await init();
}

async function shutdownBootstrap(data, reason) {
    shutdown();
}

function install(data, reason) { }
function uninstall(data, reason) { }

// O Zotero chama shutdown() com o nome "shutdown"
async function shutdown(data, reason) {
    shutdownBootstrap(data, reason);
}