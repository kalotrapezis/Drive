cmake_minimum_required(VERSION 3.24)
project(LocalDrive VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets Quick Qml QuickControls2 Sql Network Test)
find_package(KF6Kirigami REQUIRED)
find_package(KF6Solid REQUIRED)
find_package(KF6KIO REQUIRED)

qt_add_executable(local-drive
    src/main.cpp
    src/setupmodel.cpp
    src/setupmodel.h
    src/verifiedcopy.cpp
    src/verifiedcopy.h
    src/remoteinventory.cpp
    src/remoteinventory.h
    src/wirelessprotocol.h
    src/wirelesssession.cpp
    src/wirelesssession.h
)
qt_add_resources(local-drive local_drive_assets
    PREFIX "/"
    FILES src/catalog/schema.sql Assets/Icons/Drive.png
)
qt_add_resources(local-drive local_drive_qml
    PREFIX "/"
    FILES src/qml/Main.qml
)
target_link_libraries(local-drive PRIVATE Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Quick Qt6::Qml Qt6::QuickControls2 Qt6::Sql Qt6::Network KF6::Kirigami KF6::Solid KF6::KIOCore)
set_property(TARGET local-drive PROPERTY QT_QML_MODULE_NO_IMPORT_SCAN TRUE)

qt_add_executable(local-drive-cli src/cli.cpp src/verifiedcopy.cpp src/verifiedcopy.h src/remoteinventory.cpp src/remoteinventory.h src/wirelessprotocol.h src/wirelesssession.cpp src/wirelesssession.h)
qt_add_resources(local-drive-cli local_drive_cli_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(local-drive-cli PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Network KF6::KIOCore)

enable_testing()
qt_add_executable(setupmodel_test tests/setupmodel_test.cpp src/setupmodel.cpp src/setupmodel.h src/wirelessprotocol.h)
qt_add_resources(setupmodel_test setupmodel_test_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(setupmodel_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Network Qt6::Test KF6::Solid KF6::KIOCore)
add_test(NAME setupmodel_test COMMAND setupmodel_test)

qt_add_executable(verifiedcopy_test tests/verifiedcopy_test.cpp src/verifiedcopy.cpp src/verifiedcopy.h src/remoteinventory.cpp src/remoteinventory.h)
qt_add_resources(verifiedcopy_test verifiedcopy_test_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(verifiedcopy_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Test KF6::KIOCore)
add_test(NAME verifiedcopy_test COMMAND verifiedcopy_test)
add_test(NAME local_drive_cli_m0_smoke COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli_m0_smoke.sh $<TARGET_FILE:local-drive-cli>)
add_test(NAME local_drive_cli_m1_smoke COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli_m1_smoke.sh $<TARGET_FILE:local-drive-cli>)
add_test(NAME wireless_mtls_smoke COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/wireless_mtls_smoke.sh $<TARGET_FILE:local-drive-cli>)
