cmake_minimum_required(VERSION 3.24)
project(LocalDrive VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Quick Qml QuickControls2 Sql Test)
find_package(KF6Kirigami REQUIRED)
find_package(KF6Solid REQUIRED)

qt_add_executable(local-drive
    src/main.cpp
    src/setupmodel.cpp
    src/setupmodel.h
    src/verifiedcopy.cpp
    src/verifiedcopy.h
)
qt_add_resources(local-drive local_drive_assets
    PREFIX "/"
    FILES src/catalog/schema.sql Assets/Icons/Drive.png
)
qt_add_resources(local-drive local_drive_qml
    PREFIX "/"
    FILES src/qml/Main.qml
)
target_link_libraries(local-drive PRIVATE Qt6::Core Qt6::Gui Qt6::Quick Qt6::Qml Qt6::QuickControls2 Qt6::Sql KF6::Kirigami KF6::Solid)
set_property(TARGET local-drive PROPERTY QT_QML_MODULE_NO_IMPORT_SCAN TRUE)

enable_testing()
qt_add_executable(setupmodel_test tests/setupmodel_test.cpp src/setupmodel.cpp src/setupmodel.h)
qt_add_resources(setupmodel_test setupmodel_test_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(setupmodel_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Test KF6::Solid)
add_test(NAME setupmodel_test COMMAND setupmodel_test)

qt_add_executable(verifiedcopy_test tests/verifiedcopy_test.cpp src/verifiedcopy.cpp src/verifiedcopy.h)
qt_add_resources(verifiedcopy_test verifiedcopy_test_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(verifiedcopy_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Test)
add_test(NAME verifiedcopy_test COMMAND verifiedcopy_test)
