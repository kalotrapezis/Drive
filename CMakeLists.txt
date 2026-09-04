cmake_minimum_required(VERSION 3.24)
project(LocalDrive VERSION 0.1.0 LANGUAGES CXX)

include(GNUInstallDirs)

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
    src/localapi.cpp
    src/localapi.h
    src/setupmodel.cpp
    src/setupmodel.h
    src/verifiedcopy.cpp
    src/verifiedcopy.h
    src/remoteinventory.cpp
    src/remoteinventory.h
    src/wirelessprotocol.h
    src/wirelessprofile.cpp
    src/wirelessprofile.h
    src/wirelesssession.cpp
    src/wirelesssession.h
    src/wirelessreceivercontroller.cpp
    src/wirelessreceivercontroller.h
    src/metadatasync.cpp
    src/metadatasync.h
    src/managedinventory.cpp
    src/managedinventory.h
)
qt_add_resources(local-drive local_drive_assets
    PREFIX "/"
    FILES src/catalog/schema.sql Assets/Icons/Drive.png src/photo_archive.py src/photo_info.py
)
qt_add_resources(local-drive local_drive_qml
    PREFIX "/"
    FILES src/qml/Main.qml
)
target_link_libraries(local-drive PRIVATE Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Quick Qt6::Qml Qt6::QuickControls2 Qt6::Sql Qt6::Network KF6::Kirigami KF6::Solid KF6::KIOCore)
set_property(TARGET local-drive PROPERTY QT_QML_MODULE_NO_IMPORT_SCAN TRUE)

qt_add_executable(local-drive-cli src/cli.cpp src/verifiedcopy.cpp src/verifiedcopy.h src/remoteinventory.cpp src/remoteinventory.h src/wirelessprotocol.h src/wirelessprofile.cpp src/wirelessprofile.h src/wirelesssession.cpp src/wirelesssession.h src/metadatasync.cpp src/metadatasync.h)
qt_add_resources(local-drive-cli local_drive_cli_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(local-drive-cli PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Network KF6::KIOCore)

enable_testing()
qt_add_executable(setupmodel_test tests/setupmodel_test.cpp src/setupmodel.cpp src/setupmodel.h src/wirelessprotocol.h)
qt_add_resources(setupmodel_test setupmodel_test_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(setupmodel_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Network Qt6::Test KF6::Solid KF6::KIOCore)
target_compile_definitions(setupmodel_test PRIVATE LOCAL_DRIVE_TESTING)
add_test(NAME setupmodel_test COMMAND setupmodel_test)

qt_add_executable(verifiedcopy_test tests/verifiedcopy_test.cpp src/verifiedcopy.cpp src/verifiedcopy.h src/remoteinventory.cpp src/remoteinventory.h)
qt_add_resources(verifiedcopy_test verifiedcopy_test_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(verifiedcopy_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Test KF6::KIOCore)
add_test(NAME verifiedcopy_test COMMAND verifiedcopy_test)
qt_add_executable(metadatasync_test tests/metadatasync_test.cpp src/metadatasync.cpp src/metadatasync.h src/verifiedcopy.cpp src/verifiedcopy.h src/remoteinventory.cpp src/remoteinventory.h src/wirelessprotocol.h)
qt_add_resources(metadatasync_test metadatasync_test_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(metadatasync_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Test KF6::KIOCore)
add_test(NAME metadatasync_test COMMAND metadatasync_test)
qt_add_executable(managedinventory_test tests/managedinventory_test.cpp src/managedinventory.cpp src/managedinventory.h src/setupmodel.cpp src/setupmodel.h src/verifiedcopy.cpp src/verifiedcopy.h src/remoteinventory.cpp src/remoteinventory.h src/wirelessprotocol.h)
qt_add_resources(managedinventory_test managedinventory_test_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(managedinventory_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Network Qt6::Test KF6::Solid KF6::KIOCore)
target_compile_definitions(managedinventory_test PRIVATE LOCAL_DRIVE_TESTING)
add_test(NAME managedinventory_test COMMAND managedinventory_test)
qt_add_executable(localapi_test tests/localapi_test.cpp src/localapi.cpp src/localapi.h src/setupmodel.cpp src/setupmodel.h src/verifiedcopy.cpp src/verifiedcopy.h src/remoteinventory.cpp src/remoteinventory.h src/wirelessprotocol.h)
qt_add_resources(localapi_test localapi_test_assets PREFIX "/" FILES src/catalog/schema.sql src/photo_archive.py src/photo_info.py)
target_link_libraries(localapi_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Network Qt6::Test KF6::Solid KF6::KIOCore)
target_compile_definitions(localapi_test PRIVATE LOCAL_DRIVE_TESTING)
add_test(NAME localapi_test COMMAND localapi_test)
find_package(Python3 3.14 COMPONENTS Interpreter)
if(Python3_Interpreter_FOUND)
    add_test(NAME photo_archive_test COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_photo_archive.py)
    add_test(NAME photo_info_test COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_photo_info.py)
endif()
qt_add_executable(wirelessreceivercontroller_test
    tests/wirelessreceivercontroller_test.cpp
    src/wirelessreceivercontroller.cpp
    src/wirelessreceivercontroller.h
    src/wirelesssession.cpp
    src/wirelesssession.h
    src/wirelessprotocol.h
    src/wirelessprofile.cpp
    src/wirelessprofile.h
    src/setupmodel.cpp
    src/setupmodel.h
    src/verifiedcopy.cpp
    src/verifiedcopy.h
    src/remoteinventory.cpp
    src/remoteinventory.h
    src/metadatasync.cpp
    src/metadatasync.h
)
qt_add_resources(wirelessreceivercontroller_test wirelessreceivercontroller_test_assets PREFIX "/" FILES src/catalog/schema.sql)
target_link_libraries(wirelessreceivercontroller_test PRIVATE Qt6::Core Qt6::Gui Qt6::Sql Qt6::Network KF6::Solid KF6::KIOCore)
target_compile_definitions(wirelessreceivercontroller_test PRIVATE LOCAL_DRIVE_TESTING)
add_test(NAME wirelessreceivercontroller_smoke COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/wirelessreceivercontroller_smoke.sh $<TARGET_FILE:wirelessreceivercontroller_test> $<TARGET_FILE:local-drive-cli>)
add_test(NAME local_drive_cli_m0_smoke COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli_m0_smoke.sh $<TARGET_FILE:local-drive-cli>)
add_test(NAME local_drive_cli_m1_smoke COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli_m1_smoke.sh $<TARGET_FILE:local-drive-cli>)
add_test(NAME wireless_mtls_smoke COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/wireless_mtls_smoke.sh $<TARGET_FILE:local-drive-cli>)
add_test(NAME wireless_discovery_smoke COMMAND bash ${CMAKE_CURRENT_SOURCE_DIR}/tests/wireless_discovery_smoke.sh $<TARGET_FILE:local-drive-cli>)
set_tests_properties(setupmodel_test localapi_test wireless_discovery_smoke wirelessreceivercontroller_smoke PROPERTIES RESOURCE_LOCK wireless_discovery RUN_SERIAL TRUE)
set_tests_properties(wirelessreceivercontroller_smoke wireless_mtls_smoke PROPERTIES RESOURCE_LOCK wireless_protocol)

option(LOCAL_DRIVE_BUILD_WEB "Build the installed React desktop UI (run npm ci in web first)" ON)
if(LOCAL_DRIVE_BUILD_WEB)
    find_program(NPM_EXECUTABLE npm REQUIRED)
    add_custom_target(local-drive-web ALL
        COMMAND ${NPM_EXECUTABLE} run check
        COMMAND ${NPM_EXECUTABLE} run build
        WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/web
        COMMENT "Building installed desktop UI")
    add_dependencies(local-drive local-drive-web)
endif()
install(CODE "if(NOT EXISTS \"${CMAKE_CURRENT_SOURCE_DIR}/web/dist/client/index.html\")\n message(FATAL_ERROR \"Build the web UI before packaging\")\nendif()")
install(DIRECTORY web/dist/client/ DESTINATION ${CMAKE_INSTALL_DATADIR}/local-drive/web)
install(TARGETS local-drive local-drive-cli RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(FILES packaging/local-drive.desktop DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
install(FILES Assets/Icons/Drive.png DESTINATION ${CMAKE_INSTALL_DATADIR}/pixmaps RENAME local-drive.png)
install(FILES LICENSE DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/local-drive RENAME copyright)
install(FILES RELEASE_NOTES.md DESTINATION ${CMAKE_INSTALL_DATADIR}/doc/local-drive)

set(CPACK_GENERATOR "DEB")
set(CPACK_PACKAGE_NAME "local-drive")
set(CPACK_PACKAGE_VERSION "0.1.0~alpha2")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Local-first verified file and photo transfer")
set(CPACK_PACKAGE_CONTACT "Local Drive Project")
set(CPACK_DEBIAN_PACKAGE_MAINTAINER "Local Drive Project")
set(CPACK_DEBIAN_PACKAGE_SECTION "utils")
set(CPACK_DEBIAN_PACKAGE_SHLIBDEPS ON)
set(CPACK_DEBIAN_PACKAGE_DEPENDS "python3 (>= 3.14), python3-pil, libqt6sql6-sqlite, qt6-wayland, qt6-image-formats-plugins, kio-extras, udisks2, xdg-utils, qml6-module-org-kde-kirigami, qml6-module-qtcore, qml6-module-qtquick, qml6-module-qtquick-controls, qml6-module-qtquick-dialogs, qml6-module-qtquick-layouts, qml6-module-qtquick-window")
set(CPACK_DEBIAN_PACKAGE_SUGGESTS "skanpage, krita")
set(CPACK_DEBIAN_FILE_NAME DEB-DEFAULT)
set(CPACK_STRIP_FILES TRUE)
include(CPack)
