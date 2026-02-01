// function/collections/observer-collections.js

var FS_CollectionsObserver = {
    async onAdd(api, id) { return FS_Collections.onAdd(api, id); },
    async onModify(api, id) { return FS_Collections.onModify(api, id); },
    async onDelete(api, id) { return FS_Collections.onDelete(api, id); },
};