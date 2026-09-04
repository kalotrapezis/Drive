#include <QApplication>
#include <QIcon>
#include <QMenu>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QSystemTrayIcon>
#include <QWindow>
#include <QDebug>
#include <QDesktopServices>
#include <QDir>
#include <QFileInfo>
#include <QMessageBox>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTimer>
#include <QPushButton>
#include <QTextStream>
#include <unistd.h>
#include "localapi.h"
#include "managedinventory.h"
#include "setupmodel.h"
#include "verifiedcopy.h"
#include "wirelessreceivercontroller.h"

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("local-drive"));
    app.setApplicationVersion(QStringLiteral("0.1.0-alpha.2"));
    if (app.arguments().contains("--version")) { QTextStream(stdout) << "Local Drive " << app.applicationVersion() << '\n'; return 0; }
    const bool webOnly = !app.arguments().contains("--legacy-ui");
    const bool openBrowser = webOnly && !app.arguments().contains("--web-only");
    const QUrl desktopUrl(QStringLiteral("http://127.0.0.1:43172/"));
    const QString webRoot = QDir(app.applicationDirPath()).absoluteFilePath(QStringLiteral("../share/local-drive/web"));
    if (openBrowser && !QFileInfo::exists(webRoot + "/index.html")) {
        QMessageBox::critical(nullptr, "Local Drive", "Installed web UI is missing. Reinstall the package. Developers can use --web-only with the preview server."); return 1;
    }
    // KIO discovery releases its quit lock when done; the headless API must stay alive.
    if (webOnly) QCoreApplication::setQuitLockEnabled(false);
    const bool trayAvailable = QSystemTrayIcon::isSystemTrayAvailable();
    app.setQuitOnLastWindowClosed(!webOnly && !trayAvailable);
    app.setWindowIcon(QIcon(QStringLiteral(":/Assets/Icons/Drive.png")));
    QQmlApplicationEngine engine;
    SetupModel model;
    LocalApi localApi(&model);
    localApi.setWebRoot(webRoot);
    if (!localApi.start()) {
        if (openBrowser) {
            QNetworkAccessManager network; QEventLoop loop;
            auto *reply = network.get(QNetworkRequest(desktopUrl.resolved(QUrl("api/v1/health"))));
            QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
            QTimer::singleShot(2000, &loop, &QEventLoop::quit); loop.exec();
            const auto health = QJsonDocument::fromJson(reply->readAll()).object();
            const bool sameApp = health.value("application") == "local-drive" && health.value("appVersion").toString() == app.applicationVersion() && health.value("userId").toInteger(-1) == static_cast<qint64>(::geteuid());
            reply->abort();
            if (sameApp && QDesktopServices::openUrl(desktopUrl)) return 0;
            QMessageBox::warning(nullptr, "Local Drive", "Another service or older Local Drive version is using port 43172. Quit it before starting this version.");
        }
        qWarning() << "Local Drive could not bind to 127.0.0.1:43172"; return 1;
    }
    VerifiedCopy copy(model.databasePath());
    WirelessReceiverController wirelessReceiver(model.databasePath(), &model);
    ManagedRootWatcher inventoryWatcher(model.databasePath());
    QObject::connect(&model, &SetupModel::changed, &inventoryWatcher, &ManagedRootWatcher::refresh);
    inventoryWatcher.refresh();
    // Browser desktop mode does not open QML or auto-start the saved wireless receiver.
    if (webOnly) {
        QSystemTrayIcon webTray(QIcon(QStringLiteral(":/Assets/Icons/Drive.png")));
        QMenu webMenu;
        const auto show = [&] { if (!QDesktopServices::openUrl(desktopUrl)) QMessageBox::warning(nullptr, "Local Drive", "Could not open the browser. Open http://127.0.0.1:43172/ manually."); };
        const auto quit = [&] { if (QMessageBox::question(nullptr, "Quit Local Drive?", "Make sure transfers have finished. Closing Local Drive stops background work.", QMessageBox::Yes | QMessageBox::Cancel, QMessageBox::Cancel) == QMessageBox::Yes) app.quit(); };
        QObject::connect(webMenu.addAction("Open Local Drive"), &QAction::triggered, &app, show);
        QObject::connect(webMenu.addAction("Quit Local Drive"), &QAction::triggered, &app, quit);
        webTray.setContextMenu(&webMenu); webTray.setToolTip("Local Drive " + app.applicationVersion());
        if (trayAvailable) webTray.show();
        QMessageBox controls;
        if (openBrowser && !trayAvailable) {
            controls.setWindowTitle("Local Drive"); controls.setText("Local Drive is running in your browser. Keep this service open while transferring files.");
            auto *openButton = controls.addButton("Open Local Drive", QMessageBox::ActionRole);
            auto *quitButton = controls.addButton("Quit Local Drive", QMessageBox::DestructiveRole);
            QObject::connect(openButton, &QPushButton::clicked, &app, show);
            QObject::connect(quitButton, &QPushButton::clicked, &app, quit);
            QObject::connect(&controls, &QDialog::finished, &app, [&] { if (!QCoreApplication::closingDown()) controls.show(); });
            controls.show();
        }
        if (openBrowser) show();
        return app.exec();
    }
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
