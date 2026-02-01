// function/items/create.js

function _trashDestForLinked({ rootDir, trashName, attKey, filename }) {
    const base = _norm(rootDir);
    const tname = trashName || "_FSMirror_Trash";
    return _norm(`${base}/${tname}/LINKED_TRASH/${attKey}/${filename}`);
}