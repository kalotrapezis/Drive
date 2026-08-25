#include <QApplication>
#include <QIcon>
#include <QMenu>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QSystemTrayIcon>
#include <QWindow>
#include "setupmodel.h"
#include "verifiedcopy.h"
#include "wirelessreceivercontroller.h"

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    const bool trayAvailable = QSystemTrayIcon::isSystemTrayAvailable();
    app.setQuitOnLastWindowClosed(!trayAvailable);
    app.setWindowIcon(QIcon(QStringLiteral(":/Assets/Icons/Drive.png")));
    QQmlApplicationEngine engine;
    SetupModel model;
    VerifiedCopy copy(model.databasePath());
    WirelessReceiverController wirelessReceiver(model.databasePath(), &model);
    engine.rootContext()->setContextProperty("setupModel", &model);
    engine.rootContext()->setContextProperty("copyEngine", &copy);
    engine.rootContext()->setContextProperty("wirelessReceiver", &wirelessReceiver);
    engine.load(QUrl(QStringLiteral("qrc:/src/qml/Main.qml")));
    if (engine.rootObjects().isEmpty()) return 1;
    auto *window = qobject_cast<QWindow *>(engine.rootObjects().first());
    if (!window) return 1;
    window->setProperty("trayAvailable", trayAvailable);

    QSystemTrayIcon tray;
    QMenu trayMenu;
    if (trayAvailable) {
        tray.setIcon(QIcon(QStringLiteral(":/Assets/Icons/Drive.png")));
        tray.setToolTip(QStringLiteral("Local Drive"));
        QAction *showAction = trayMenu.addAction(QObject::tr("Show Local Drive"));
        QAction *transferAction = trayMenu.addAction(QObject::tr("Pause transfer"));
        QAction *cancelAction = trayMenu.addAction(QObject::tr("Cancel transfer"));
        trayMenu.addSeparator();
        QAction *exitAction = trayMenu.addAction(QObject::tr("Exit Local Drive"));
        QObject::connect(showAction, &QAction::triggered, window, [window] { window->show(); window->raise(); window->requestActivate(); });
        QObject::connect(transferAction, &QAction::triggered, &copy, [&copy] { copy.paused() ? copy.resume() : copy.pause(); });
        QObject::connect(cancelAction, &QAction::triggered, &copy, &VerifiedCopy::cancel);
        QObject::connect(exitAction, &QAction::triggered, &app, [window, &app] { window->setProperty("allowQuit", true); app.quit(); });
        const auto updateTray = [&copy, transferAction, cancelAction] {
            transferAction->setText(copy.paused() ? QObject::tr("Resume transfer") : QObject::tr("Pause transfer"));
            transferAction->setEnabled(copy.running());
            cancelAction->setEnabled(copy.running());
        };
        QObject::connect(&copy, &VerifiedCopy::runningChanged, &app, updateTray);
        QObject::connect(&copy, &VerifiedCopy::pausedChanged, &app, updateTray);
        updateTray();
        tray.setContextMenu(&trayMenu);
        tray.show();
    }
    return app.exec();
}
