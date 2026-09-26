#pragma once
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSqlError>
#include <QStringList>

// Widen the two CHECK constraints without dropping receipts or foreign-key links.
inline bool upgradeYearRetention(QSqlDatabase &db, QString *error) {
    QSqlQuery q(db);
    if (!q.exec("SELECT version FROM schema_version") || !q.next()) { if (error) *error = q.lastError().text(); return false; }
    if (q.value(0).toInt() >= 18) return true;
    q.finish();
    auto fail = [&] { if (error) *error = q.lastError().text(); db.rollback(); q.exec("PRAGMA foreign_keys=ON"); return false; };
    if (!q.exec("PRAGMA foreign_keys=OFF") || !db.transaction()) return fail();
    for (const QString &table : {QStringLiteral("routes"), QStringLiteral("jobs")}) {
        q.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?"); q.addBindValue(table);
        if (!q.exec() || !q.next()) return fail();
        QString definition = q.value(0).toString(); q.finish();
        definition.replace("'Everything', 'Last month'", "'Everything', 'Last year', 'Last month'");
        // Old migrations use compact SQL; both spellings are part of our catalog history.
        definition.replace("'Everything','Last month'", "'Everything','Last year','Last month'");
        definition.replace("CREATE TABLE " + table, "CREATE TABLE " + table + "_year");
        q.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL"); q.addBindValue(table);
        if (!q.exec()) return fail();
        QStringList dependent; while (q.next()) dependent.append(q.value(0).toString()); q.finish();
        if (!q.exec(definition) || !q.exec("INSERT INTO " + table + "_year SELECT * FROM " + table)
            || !q.exec("DROP TABLE " + table) || !q.exec("ALTER TABLE " + table + "_year RENAME TO " + table)) return fail();
        for (const auto &sql : dependent) if (!q.exec(sql)) return fail();
    }
    if (!q.exec("PRAGMA foreign_key_check")) return fail();
    if (q.next()) { db.rollback(); q.exec("PRAGMA foreign_keys=ON"); if (error) *error = "Foreign-key check failed during retention upgrade"; return false; }
    q.finish();
    if (!q.exec("UPDATE schema_version SET version=18,installed_at=CURRENT_TIMESTAMP WHERE singleton=1") || !db.commit()) return fail();
    return q.exec("PRAGMA foreign_keys=ON");
}
