/* global OS */

var FSMirrorFS = {
    async exists(path) {
        try { return await OS.File.exists(path); }
        catch { return false; }
    },

    async ensureDir(path, log, dryRun = false) {
        log(`mkdir -p "${path}"`);
        if (dryRun) return;
        await OS.File.makeDir(path, { ignoreExisting: true, unixMode: 0o755 });
    },

    async moveDir(src, dst, log, dryRun = false) {
        if (src === dst) return;
        log(`mv "${src}" -> "${dst}"`);
        if (dryRun) return;

        const parent = dst.split("/").slice(0, -1).join("/");
        await OS.File.makeDir(parent, { ignoreExisting: true });
        await OS.File.move(src, dst);
    },

    async trashMove(path, rootDir, trashName, log, dryRun = false) {
        const trash = `${rootDir}/${trashName}`.replace(/\/+/g, "/");
        await this.ensureDir(trash, log, dryRun);

        const base = path.split("/").pop();
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const dst = `${trash}/${base}__DELETED__${stamp}`.replace(/\/+/g, "/");

        log(`trash "${path}" -> "${dst}"`);
        if (dryRun) return;

        if (await this.exists(path)) {
            await OS.File.move(path, dst);
        } else {
            log(`trash skip missing "${path}"`);
        }
    }
};