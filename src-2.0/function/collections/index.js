// function/collections/index.js

var FS_Collections = {
    onAdd:    (api, id) => FS_CollectionsCreate.onAdd(api, id),
    onModify: (api, id) => FS_CollectionsUpdate.onModify(api, id),
    onDelete: (api, id) => FS_CollectionsDelete.onDelete(api, id),
};