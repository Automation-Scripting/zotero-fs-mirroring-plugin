// function/items/read.js

function _isAttachmentItem(item) {
    if (!item) return false;
    if (typeof item.isAttachment === "function") return !!item.isAttachment();
    return !!item.isAttachment;
}

function _isInTrash(item) {
    if (!item) return false;
    if (typeof item.isInTrash === "function") return !!item.isInTrash();
    if (typeof item.isInTrash === "boolean") return item.isInTrash;
    return false;
}