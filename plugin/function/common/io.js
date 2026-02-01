// function/common/io.js

var IOUtils = globalThis.IOUtils;

// depende de: _norm, _parentDir, _baseName
// (carregue common/path.js antes)

async function _exists(p) {
    try { return await IOUtils.exists(_norm(p)); } catch { return false; }
}

async function _ensureDir(p) {
    return IOUtils.makeDirectory(_norm(p), { createAncestors: true });
}

async function _copyFile(src, dst) {
    src = _norm(src); dst = _norm(dst);
    const bytes = await IOUtils.read(src);
    await _ensureDir(_parentDir(dst));
    await IOUtils.write(dst, bytes);
}

async function _moveFile(src, dst) {
    // move real: copy + remove
    await _copyFile(src, dst);
    try { await IOUtils.remove(_norm(src)); } catch { }
}

// Regra de colisão: se dst existe -> (2), (3), ...
async function _uniquePath(dst) {
    dst = _norm(dst);
    if (!(await _exists(dst))) return dst;

    const dir = _parentDir(dst);
    const name = _baseName(dst);

    const m = name.match(/^(.*?)(\.[^.]*)$/); // foo.pdf
    const stem = m ? m[1] : name;
    const ext = m ? m[2] : "";

    for (let i = 2; i < 1000; i++) {
        const cand = _norm(`${dir}/${stem} (${i})${ext}`);
        if (!(await _exists(cand))) return cand;
    }
    return dst; // fallback improvável
}

async function _removeFileIfExists(p) {
    try {
        p = _norm(p);
        if (await _exists(p)) await IOUtils.remove(p);
    } catch { }
}

async function _removeDirIfEmpty(dir) {
    try {
        dir = _norm(dir);
        // Se não existe, nada
        if (!(await _exists(dir))) return;

        // IOUtils.getChildren() existe em builds recentes; fallback: tenta listar via PathUtils?
        if (typeof IOUtils.getChildren !== "function") return;

        const children = await IOUtils.getChildren(dir);
        if (children && children.length === 0) {
            await IOUtils.remove(dir); // remove dir vazio

            // tenta remover o parent se também ficar vazio (limpa "attKey/")
            const parent = _parentDir(dir);
            if (parent && parent !== dir) {
                const parentChildren = await IOUtils.getChildren(parent);
                if (parentChildren && parentChildren.length === 0) {
                    await IOUtils.remove(parent);
                }
            }
        }
    } catch { }
}

async function _listDirNames(dirPath) {
    const out = [];

    try {
        const entries = await IOUtils.getChildren(dirPath);
        for (const entry of entries) {
            // entry é o path completo
            const name = PathUtils.filename(entry);
            out.push(name);
        }
    } catch (e) {
        // diretório não existe ou erro de permissão
        return [];
    }

    return out;
}

async function _isDir(p) {
    try {
        // Em builds recentes: IOUtils.stat existe e retorna { type: "directory" | "file" | ... }
        if (typeof IOUtils.stat === "function") {
            const st = await IOUtils.stat(_norm(p));
            return st && st.type === "directory";
        }

        // Fallback ultra conservador: tenta listar filhos
        if (typeof IOUtils.getChildren === "function") {
            await IOUtils.getChildren(_norm(p));
            return true; // se listou, é diretório
        }

        return false;
    } catch {
        return false;
    }
}

// Move/rename de diretório (preferência por move nativo; fallback copy+remove)
async function _moveDir(src, dst) {
    src = _norm(src); dst = _norm(dst);

    // Preferir move nativo se existir (atômico no mesmo FS)
    if (typeof IOUtils.move === "function") {
        await _ensureDir(_parentDir(dst));
        await IOUtils.move(src, dst);
        return;
    }

    // Fallback: copy recursivo + remove
    await _copyDir(src, dst);
    try { await IOUtils.remove(src, { recursive: true }); } catch { }
}

// Copy recursivo (para fallback do moveDir)
async function _copyDir(src, dst) {
    src = _norm(src); dst = _norm(dst);
    await _ensureDir(dst);

    if (typeof IOUtils.getChildren !== "function") {
        throw new Error("IOUtils.getChildren not available; cannot copy dir recursively");
    }

    const children = await IOUtils.getChildren(src);
    for (const child of children) {
        const name = PathUtils.filename(child);
        const dstChild = _norm(dst + "/" + name);

        if (await _isDir(child)) {
            await _copyDir(child, dstChild);
        } else {
            await _copyFile(child, dstChild);
        }
    }
}