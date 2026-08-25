#include <QCoreApplication>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTimer>
#include <QDebug>

#include "../src/wirelessreceivercontroller.h"
#include "../src/setupmodel.h"

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QCoreApplication::setQuitLockEnabled(false);
    if (argc != 7) return 2;
    SetupModel model(argv[1]);
    if (!model.ready()) return 3;
    QSqlDatabase seed = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), QStringLiteral("controller-seed"));
    seed.setDatabaseName(argv[1]);
    if (!seed.open()) return 4;
    QSqlQuery query(seed);
    if (!query.exec(QStringLiteral("INSERT OR IGNORE INTO devices(id,stable_id,name,kind,is_local) VALUES('mtp-phone','mtp:phone','Test phone','Phone',0)"))) return 5;
    if (!query.exec(QStringLiteral("INSERT OR REPLACE INTO device_aliases(alias,device_id,transport) VALUES('wireless:controller-phone','mtp-phone','wireless')"))) return 6;
    query.finish();
    seed.close();
    seed = QSqlDatabase();
    QSqlDatabase::removeDatabase(QStringLiteral("controller-seed"));
#ifdef LOCAL_DRIVE_TESTING
    model.setMtpDevicesForTest({QVariantMap{{"id", "mtp-phone"}, {"stableIdentity", "mtp:phone"}, {"label", "Test phone"}, {"kind", "mtp"}, {"transport", "mtp"}, {"present", true}, {"status", "Online"}}});
#endif
    WirelessReceiverController controller(argv[1], &model);
    if (!controller.start(argv[2], argv[3], argv[4], argv[5], argv[6], 43273)) return 3;
    qInfo().noquote() << QStringLiteral("LISTENING port=%1").arg(controller.port());
    QTimer timeout;
    timeout.setSingleShot(true);
    timeout.setInterval(30000);
    QObject::connect(&timeout, &QTimer::timeout, &app, [&app] { app.exit(4); });
    QObject::connect(&controller, &WirelessReceiverController::changed, &app, [&controller, &model, &app] {
        static bool finishing = false;
        const QStringList entries = controller.logEntries();
        if (!entries.isEmpty()) qInfo().noquote() << entries.last();
        if (!finishing && controller.status().startsWith(QStringLiteral("Received "))) {
            finishing = true;
            QTimer::singleShot(500, &app, [&app, &model] {
                const auto devices = model.connectedDevices();
                bool oneMerged = devices.size() == 1;
                if (oneMerged) {
                    const QVariantMap device = devices.first().toMap();
                    const QStringList transports = device.value("transports").toStringList();
                    oneMerged = device.value("id").toString() == QStringLiteral("mtp-phone") && transports.contains("mtp") && transports.contains("wireless");
                }
                app.exit(oneMerged ? 0 : 7);
            });
        }
    });
    timeout.start();
    return app.exec();
}
