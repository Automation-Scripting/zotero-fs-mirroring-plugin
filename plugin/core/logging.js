// core/logging.js

var IOUtils = globalThis.IOUtils;
var PathUtils = globalThis.PathUtils;

(function () {
  // -----------------------------
  // External logger (IOUtils) + Zotero.debug
  // -----------------------------
  FS_Mirror._logFilePath = null;
  FS_Mirror._logWriteChain = Promise.resolve();
  FS_Mirror._runID = null;
  FS_Mirror._debug = true;
  FS_Mirror._echoToZotero = true;

  FS_Mirror.initLogger = async function () {
    this._debug = !!Zotero.Prefs.get("extensions.fs-mirror.debug", true);
    this._echoToZotero = !!Zotero.Prefs.get("extensions.fs-mirror.echoToZotero", true);

    let logsDir = Zotero.Prefs.get("extensions.fs-mirror.logsDir", true);

    // fallback: usa rootDir/logs se logsDir não setado
    if (!logsDir) {
      const rootDir = Zotero.Prefs.get("extensions.fs-mirror.rootDir", true);
      logsDir = rootDir ? _joinPath(rootDir, "logs") : null;
    }
    // último fallback: home/FSMirror/logs
    if (!logsDir) {
      logsDir = _joinPath(PathUtils?.homeDir || "", "FSMirror", "logs");
    }

    // cria diretório (recursive)
    try {
      await IOUtils.makeDirectory(logsDir, { createAncestors: true });
    } catch (e) {
      Zotero.debug(`[FS Mirror] ${_ts()} WARN cannot create logsDir="${logsDir}": ${String(e)}`);
      this._logFilePath = null;
      return;
    }

    this._runID = Math.random().toString(36).slice(2, 8);
    const fileName = `fs-mirror-${_dateStamp()}-${this._runID}.log`;
    this._logFilePath = _joinPath(logsDir, fileName);

    // garante que o arquivo existe
    try {
      if (!(await IOUtils.exists(this._logFilePath))) {
        await IOUtils.write(this._logFilePath, new Uint8Array());
      }
    } catch (e) {
      Zotero.debug(`[FS Mirror] ${_ts()} WARN cannot create logfile="${this._logFilePath}": ${String(e)}`);
      this._logFilePath = null;
      return;
    }

    this.info("LOG", `external logfile="${this._logFilePath}"`);
    this.info("LOG", `debug=${this._debug} echoToZotero=${this._echoToZotero}`);
  };

  FS_Mirror._appendLogLine = function (line) {
    if (!this._logFilePath) return;

    this._logWriteChain = this._logWriteChain.then(async () => {
      try {
        const enc = new TextEncoder();
        const bytes = enc.encode(line);

        if (!(await IOUtils.exists(this._logFilePath))) {
          await IOUtils.write(this._logFilePath, bytes);
          return;
        }

        const prev = await IOUtils.read(this._logFilePath);
        const next = new Uint8Array(prev.length + bytes.length);
        next.set(prev, 0);
        next.set(bytes, prev.length);
        await IOUtils.write(this._logFilePath, next);
      } catch (e) {
        Zotero.debug(`[FS Mirror] ${_ts()} ERROR write logfile: ${String(e)}`);
      }
    });
  };

  FS_Mirror._emit = function (level, tag, msg) {
    if (level === "DEBUG" && !this._debug) return;

    const line = `${_ts()} ${level} ${tag} ${msg}`;
    if (this._echoToZotero) {
      Zotero.debug(`[FS Mirror] ${line}`);
    }
    this._appendLogLine(line + "\n");
  };

  FS_Mirror.debug = function (tag, msg) { this._emit("DEBUG", tag, msg); };
  FS_Mirror.info  = function (tag, msg) { this._emit("INFO", tag, msg); };
  FS_Mirror.warn  = function (tag, msg) { this._emit("WARN", tag, msg); };
  FS_Mirror.error = function (tag, msg) { this._emit("ERROR", tag, msg); };

  // compat
  FS_Mirror.log = function (msg) { this.info("APP", msg); };
})();