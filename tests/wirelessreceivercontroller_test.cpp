#include <QCoreApplication>
#include <QTimer>
#include <QDebug>

#include "../src/wirelessreceivercontroller.h"

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    if (argc != 7) return 2;
    WirelessReceiverController controller(argv[1]);
    if (!controller.start(argv[2], argv[3], argv[4], argv[5], argv[6], 43273)) return 3;
    qInfo().noquote() << QStringLiteral("LISTENING port=%1").arg(controller.port());
    QTimer timeout;
    timeout.setSingleShot(true);
    timeout.setInterval(30000);
    QObject::connect(&timeout, &QTimer::timeout, &app, [&app] { app.exit(4); });
    QObject::connect(&controller, &WirelessReceiverController::changed, &app, [&controller, &app] {
        static bool finishing = false;
        const QStringList entries = controller.logEntries();
        if (!entries.isEmpty()) qInfo().noquote() << entries.last();
        if (!finishing && controller.status().startsWith(QStringLiteral("Received "))) {
            finishing = true;
            QTimer::singleShot(500, &app, [&app] { app.exit(0); });
        }
    });
    timeout.start();
    return app.exec();
}
