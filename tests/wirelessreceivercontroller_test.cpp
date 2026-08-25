#include <QCoreApplication>
#include <QDir>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSettings>
#include <QTimer>
#include <QDebug>

#include "../src/wirelessreceivercontroller.h"
#include "../src/setupmodel.h"

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QCoreApplication::setQuitLockEnabled(false);
    if (argc != 7) return 2;
    const QString databasePath = QString::fromLocal8Bit(argv[1]);
    QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, QDir(argv[1]).filePath(QStringLiteral("settings")));
    SetupModel model(argv[1]);
    if (!model.ready()) return 3;
    QSqlDatabase seed = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), QStringLiteral("controller-seed"));
    seed.setDatabaseName(argv[1]);
    if (!seed.open()) return 4;
    QSqlQuery query(seed);
    if (!query.exec(QStringLiteral("INSERT OR IGNORE INTO devices(id,stable_id,name,kind,is_local) VALUES('mtp-phone','mtp:phone','Test phone','Phone',0)"))) return 5;
    if (!query.exec(QStringLiteral("INSERT OR REPLACE INTO device_aliases(alias,device_id,transport) VALUES('mtp:phone','mtp-phone','mtp')"))) return 6;
    query.finish();
    seed.close();
    seed = QSqlDatabase();
    QSqlDatabase::removeDatabase(QStringLiteral("controller-seed"));
#ifdef LOCAL_DRIVE_TESTING
    model.setMtpDevicesForTest({QVariantMap{{"id", "mtp-phone"}, {"stableIdentity", "mtp:phone"}, {"label", "Test phone"}, {"kind", "mtp"}, {"transport", "mtp"}, {"present", true}, {"status", "Online"}}});
#endif
    if (!model.ingestWirelessBeacon(QVariantMap{{"stableIdentity", "wireless:controller-phone"}, {"label", "Controller phone"}})) return 7;
    const QString candidateId = model.wirelessDevices().first().toMap().value("id").toString();
    if (candidateId == QStringLiteral("mtp-phone") || !model.pairWirelessDevice(candidateId, QStringLiteral("mtp-phone"))) return 8;
    WirelessReceiverController controller(argv[1], &model);
    if (!controller.start(argv[2], argv[3], argv[4], argv[5], argv[6], 43273)) return 3;
    qInfo().noquote() << QStringLiteral("LISTENING port=%1").arg(controller.port());
    QTimer timeout;
    timeout.setSingleShot(true);
    timeout.setInterval(30000);
    QObject::connect(&timeout, &QTimer::timeout, &app, [&app] { app.exit(4); });
    QObject::connect(&controller, &WirelessReceiverController::changed, &app, [&controller, &model, &app, databasePath] {
        static bool finishing = false;
        const QStringList entries = controller.logEntries();
        if (!entries.isEmpty()) qInfo().noquote() << entries.last();
        if (!finishing && controller.status().startsWith(QStringLiteral("Received "))) {
            finishing = true;
            QTimer::singleShot(500, &app, [&app, &model, &controller, databasePath] {
                const auto devices = model.connectedDevices();
                bool oneMerged = devices.size() == 1;
                if (oneMerged) {
                    const QVariantMap device = devices.first().toMap();
                    const QStringList transports = device.value("transports").toStringList();
                    oneMerged = device.value("id").toString() == QStringLiteral("mtp-phone") && transports.contains("mtp") && transports.contains("wireless");
                }
                WirelessReceiverController restored(databasePath);
                const bool remembered = restored.savedEnabled() && restored.savedPort() == 43273 && restored.savedDestination() == controller.savedDestination();
                bool canonicalCatalog = false;
                QSqlDatabase check = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), QStringLiteral("controller-catalog-check"));
                check.setDatabaseName(databasePath);
                if (check.open()) {
                    QSqlQuery catalogQuery(check);
                    if (catalogQuery.exec(QStringLiteral("SELECT COUNT(*) FROM storage WHERE id LIKE 'wireless-storage-%' AND device_id='mtp-phone'")) && catalogQuery.next() && catalogQuery.value(0).toInt() == 1
                        && catalogQuery.exec(QStringLiteral("SELECT COUNT(*) FROM device_aliases WHERE alias='wireless:controller-phone' AND device_id='mtp-phone'")) && catalogQuery.next() && catalogQuery.value(0).toInt() == 1) canonicalCatalog = true;
                    catalogQuery.finish();
                    check.close();
                }
                check = QSqlDatabase();
                QSqlDatabase::removeDatabase(QStringLiteral("controller-catalog-check"));
                restored.stop();
                WirelessReceiverController stopped(databasePath);
                app.exit(oneMerged && remembered && canonicalCatalog && !stopped.savedEnabled() ? 0 : 7);
            });
        }
    });
    timeout.start();
    return app.exec();
}
