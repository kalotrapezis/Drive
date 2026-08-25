package org.localdrive.android;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

/** Streams files from a user-granted fixed root without loading file contents into memory. */
public final class RootScanner {
    public interface Visitor { boolean visit(Entry entry) throws Exception; }

    public static final class Entry {
        public final Uri uri;
        public final String relative;
        public final long size;
        public final long modified;

        Entry(Uri uri, String relative, long size, long modified) {
            this.uri = uri;
            this.relative = relative;
            this.size = size;
            this.modified = modified;
        }
    }

    private RootScanner() {}

    public static boolean scan(Context context, Uri tree, Visitor visitor) throws Exception {
        return scanDirectory(context, tree, DocumentsContract.getTreeDocumentId(tree), "", visitor);
    }

    private static boolean scanDirectory(Context context, Uri tree, String documentId, String parent, Visitor visitor) throws Exception {
        final Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId);
        final String[] columns = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED};
        try (Cursor cursor = context.getContentResolver().query(children, columns, null, null, DocumentsContract.Document.COLUMN_DISPLAY_NAME)) {
            if (cursor == null) throw new IllegalStateException("Android root cannot be scanned");
            final int idColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            final int nameColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            final int mimeColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE);
            final int sizeColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE);
            final int modifiedColumn = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
            while (cursor.moveToNext()) {
                final String id = cursor.getString(idColumn);
                final String name = safeName(cursor.getString(nameColumn));
                if (id == null || name.isEmpty()) continue;
                final String relative = parent.isEmpty() ? name : parent + "/" + name;
                final Uri item = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(mimeColumn))) {
                    if (!scanDirectory(context, tree, id, relative, visitor)) return false;
                } else if (!visitor.visit(new Entry(item, relative, Math.max(0, cursor.getLong(sizeColumn)), Math.max(0, cursor.getLong(modifiedColumn))))) {
                    return false;
                }
            }
        }
        return true;
    }

    private static String safeName(String value) {
        if (value == null || value.trim().isEmpty() || ".".equals(value) || "..".equals(value)) return "";
        return value.replace('/', '_').replace('\\', '_');
    }
}
