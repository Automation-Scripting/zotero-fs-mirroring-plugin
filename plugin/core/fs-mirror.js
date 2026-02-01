// core/fs-mirror.js

var IOUtils = globalThis.IOUtils;
var PathUtils = globalThis.PathUtils;

// FS_Mirror CORE: estado + lifecycle
FS_Mirror = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,

  // UI state
  addedElementIDs: [],

  // Collections cache
  colPathCache: new Map(),

  // Items cache (fallback p/ delete pós-commit)
  // key: itemID -> { lastPath, trashedPath, ts, kind, isPDF, linkMode, attKey }
  _itemFSState: new Map(),

  init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.initialized = true;
  },

  toggleGreen(window, enabled) {
    window.document.documentElement.toggleAttribute("data-green-instead", enabled);
  },

  async main() {
    // logging.js injeta initLogger/info/warn/etc
    if (typeof this.initLogger === "function") {
      await this.initLogger();
    }

    // notifier.js injeta _registerObservers/_unregisterObservers
    if (typeof this._registerObservers === "function") {
      this._registerObservers();
      this.info?.("MAIN", "observers registered (dry mode)");
    } else {
      Zotero.debug(`[FS Mirror] ${_ts()} WARN _registerObservers not found (did you load notifier.js?)`);
    }

    // exemplo/diagnóstico
    var host = new URL("https://foo.com/path").host;
    this.log?.(`Host is ${host}`);

    // prefs
    this.log?.(`[Preferences] Root dir: ${Zotero.Prefs.get("extensions.fs-mirror.rootDir", true)}`);
    this.log?.(`[Preferences] Logs dir: ${Zotero.Prefs.get("extensions.fs-mirror.logsDir", true)}`);
    this.log?.(`[Preferences] Trash folder: ${Zotero.Prefs.get("extensions.fs-mirror.safeTrashDirName", true)}`);
    this.log?.(`[Preferences] Debug mode: ${Zotero.Prefs.get("extensions.fs-mirror.debug", true)}`);
    this.log?.(`[Preferences] Internal logs: ${Zotero.Prefs.get("extensions.fs-mirror.echoToZotero", true)}`);

    this.info?.("MAIN", "logger ready (if logfile path exists, it will be written)");
  },

  // -----------------------------
  // FS ACTIONS (LOGS + ACTION)
  // Semântica: chamamos de "MOVE", mas fazemos COPY (não apaga o original)
  // -----------------------------

  async fsEnsureParentDir(filePath) {
    const parent = PathUtils.parent(filePath);
    await IOUtils.makeDirectory(parent, { createAncestors: true });
  },

  async fsPathExists(p) {
    try { return await IOUtils.exists(p); }
    catch { return false; }
  },

  /**
   * "MOVE" no contrato, mas implementa COPY.
   * - Não sobrescreve destino
   * - Cria diretório pai
   * - Copia bytes (origem permanece)
   */
  async fsMoveFile(src, dst) {
    try {
      this.info?.("FS", `MOVE (copy) "${src}" -> "${dst}"`);

      if (!src || !dst) {
        this.warn?.("FS", "MOVE skipped (src/dst missing)");
        return { ok: false, reason: "missing_path" };
      }

      if (!(await this.fsPathExists(src))) {
        this.warn?.("FS", `MOVE skipped (src missing) "${src}"`);
        return { ok: false, reason: "src_missing" };
      }

      if (await this.fsPathExists(dst)) {
        this.warn?.("FS", `MOVE skipped (dst exists) "${dst}"`);
        return { ok: false, reason: "dst_exists" };
      }

      await this.fsEnsureParentDir(dst);

      const bytes = await IOUtils.read(src);
      await IOUtils.write(dst, bytes);

      this.info?.("FS", `MOVE (copy) done "${dst}"`);
      return { ok: true };
    } catch (e) {
      this.error?.("FS", `MOVE (copy) failed: ${String(e)}`);
      return { ok: false, reason: "exception", error: String(e) };
    }
  },
};