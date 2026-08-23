#include <QGuiApplication>
#include <QIcon>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include "setupmodel.h"

int main(int argc, char **argv) {
    QGuiApplication app(argc, argv);
    app.setWindowIcon(QIcon(QStringLiteral(":/Assets/Icons/Drive.png")));
    QQmlApplicationEngine engine;
    SetupModel model;
    engine.rootContext()->setContextProperty("setupModel", &model);
    engine.load(QUrl(QStringLiteral("qrc:/src/qml/Main.qml")));
    if (engine.rootObjects().isEmpty()) return 1;
    return app.exec();
}
