import QtQuick
import QtQuick.Controls as Controls
import QtQuick.Layouts
import QtQuick.Dialogs
import org.kde.kirigami as Kirigami

Kirigami.ApplicationWindow {
    visible: true
    property bool allowQuit: false
    property bool trayAvailable: true
    width: 900; height: 700
    title: qsTr("Local Drive — Setup")
    property var selectedPreview: ({})
    property var selectedCleanup: ({files: 0, bytes: 0})
    property var selectedHistory: []
    property string previewRouteId: ""
    property real transferProgress: 0
    property string transferPath: ""
    property string manifestStatus: ""
    property string onboardingDeviceId: ""
    property string currentMode: "Sync"
    property bool showingSettings: false
    property int settingsContentIndex: 0
    property var phoneActionDevice: ({})
    property var connectedPhone: setupModel.connectedDevices.length > 0 ? setupModel.connectedDevices[0] : ({})
    property string phoneActionStatus: ""
    property double pauseRemainingMilliseconds: 0
    property var contentTypes: ["Drive", "Photos"]
    property var onboardingDevice: {
        const devices = setupModel.firstSeenDevices
        for (let index = 0; index < devices.length; ++index) {
            if (devices[index].id === onboardingDeviceId) return devices[index]
        }
        return ({})
    }
    property var activeRoute: {
        const routes = setupModel.routes
        for (let index = 0; index < routes.length; ++index) {
            if (routes[index].id === previewRouteId) return routes[index]
        }
        return ({})
    }
    property var keepPolicies: ["Everything", "Last month", "Last week", "Last day", "Nothing"]
    function refreshAll() {
        if (!setupModel.ready) return
        setupModel.refreshStorages()
        setupModel.refreshMtpDevices()
        setupModel.startWirelessDiscovery()
        setupModel.refreshRoutes()
    }
    function saveCurrentRoute() {
        if (!saveRouteButton.enabled) return
        setupModel.saveRoute(source.text, storage.currentValue, destination.text, keepPolicies[keepPolicy.currentIndex], minimumFreeSpace.value * 1024 * 1024, organizePhotos.checked && contentTypes[contentType.currentIndex] === "Photos", stagingMaximum.value * 1024 * 1024, stagingRoot.text, contentTypes[contentType.currentIndex])
    }
    function startSelectedRoute() {
        if (copyEngine.running || previewRouteId.length === 0 || selectedPreview.ok !== true || !copyEngine.previewSuccessful) return
        copyEngine.startCopy()
    }
    function routeDescription() {
        return keepPolicyDescription(keepPolicies[keepPolicy.currentIndex])
    }
    function keepPolicyDescription(policy) {
        if (policy === "Nothing") return qsTr("Keep Nothing — verified Move; requires explicit Trash confirmation")
        if (policy === "Last month") return qsTr("Keep Last month — copy and verify; review older sources before Trash")
        if (policy === "Last week") return qsTr("Keep Last week — copy and verify; review older sources before Trash")
        if (policy === "Last day") return qsTr("Keep Last day — copy and verify; review older sources before Trash")
        return qsTr("Keep Everything — copy and verify; retain source")
    }
    function errorNextAction(code) {
        if (code === "cancelled") return qsTr("Retry the job; completed items remain verified.")
        if (code === "interrupted") return qsTr("Retry the transfer; verified destinations remain safe.")
        if (code === "catalog_error") return qsTr("Review the system Trash and catalog before retrying cleanup.")
        if (code === "source_changed") return qsTr("Rescan the source and preview again.")
        if (code === "permission_denied") return qsTr("Fix permissions, then preview again.")
        if (code === "insufficient_space") return qsTr("Free space or lower the safety margin, then retry.")
        if (code === "destination_wrong_device" || code === "destination_unavailable") return qsTr("Reconnect the exact destination and preview again.")
        if (code === "name_conflict") return qsTr("Review the conflict before retrying.")
        if (code === "unsupported_trash") return qsTr("Keep the source and retry cleanup when Trash is available.")
        return qsTr("Check the reported problem, then retry safely.")
    }
    function selectedStorageLabel() { return storage.currentIndex >= 0 ? storage.currentText : qsTr("No external storage detected") }
    function modeIndex() { return showingSettings ? 4 : ["Sync", "Drive", "Photos", "New"].indexOf(currentMode) }
    function firstRouteFor(type) {
        const routes = setupModel.routes.filter(function(route) { return route.contentType === type })
        return routes.length > 0 ? routes[0] : ({})
    }
    function phoneSourceUrl(root) {
        let base = phoneActionDevice.phoneRoot || phoneActionDevice.url || ""
        if (base.length === 0) return ""
        if (base.indexOf("mtp:") === 0) base = base.substring(4)
        if (!base.endsWith("/")) base += "/"
        return "mtp:" + base + root + "/"
    }
    function openPhoneActions() {
        phoneActionDevice = connectedPhone
        phoneActionStatus = ""
        phoneActionDialog.open()
    }
    function startPhoneImport(type, root) {
        const route = firstRouteFor(type)
        if (route.id === undefined) { phoneActionStatus = qsTr("Save a %1 route first in Sync.").arg(type); return }
        const started = copyEngine.startRemoteImportDirectory({
            sourceUrl: phoneSourceUrl(root),
            destinationRoot: route.destination,
            selectedStorageRoot: route.storageRoot,
            storageIdentity: route.storageIdentity,
            filesystemType: route.filesystemType,
            routeId: route.id,
            destinationStorageId: route.storageId,
            sourceStorageId: phoneActionDevice.id + "-storage",
            sourceStorageIdentity: phoneActionDevice.stableIdentity,
            sourceStorageLabel: phoneActionDevice.label,
            sourceDeviceId: phoneActionDevice.id,
            sourceDeviceStableId: phoneActionDevice.stableIdentity,
            sourceDeviceName: phoneActionDevice.label
        })
        if (started) { phoneActionDialog.close(); currentMode = "Sync" }
        else phoneActionStatus = qsTr("Could not start the import. Check the route, storage identity, and phone connection.")
    }
    function pauseDurationMilliseconds() {
        const multipliers = [60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000]
        return (pauseAmount.currentIndex + 1) * multipliers[pauseUnit.currentIndex]
    }
    function scheduleResumeTimer() {
        resumeTimer.interval = Math.min(pauseRemainingMilliseconds, 2147483647)
        resumeTimer.start()
    }
    function pauseTransferFor(milliseconds) {
        if (!copyEngine.running || copyEngine.paused) return
        resumeTimer.stop()
        copyEngine.pause()
        pauseRemainingMilliseconds = Math.max(0, milliseconds)
        if (pauseRemainingMilliseconds > 0) scheduleResumeTimer()
    }
    function resumeTransfer() {
        resumeTimer.stop()
        pauseRemainingMilliseconds = 0
        copyEngine.resume()
    }
    Component {
        id: routeMapCard
        Kirigami.Card {
            property var route: modelData
            Layout.fillWidth: true
            contentItem: ColumnLayout {
                RowLayout {
                    Layout.fillWidth: true
                    ColumnLayout {
                        Layout.fillWidth: true
                        Controls.Label { text: qsTr("Computer / source"); font.bold: true; Accessible.name: text }
                        Controls.Label { text: route.source || qsTr("Not configured"); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text }
                    }
                    Controls.Label { text: qsTr("→"); font.pointSize: Kirigami.Theme.defaultFont.pointSize * 1.4; Accessible.name: qsTr("to") }
                    ColumnLayout {
                        Layout.fillWidth: true
                        Controls.Label { text: qsTr("Storage / destination"); font.bold: true; Accessible.name: text }
                        Controls.Label { text: route.destination || qsTr("Not configured"); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text }
                    }
                }
                Controls.Label { text: qsTr("%1 · %2").arg(route.contentType || qsTr("Drive")).arg(keepPolicyDescription(route.keepPolicy)); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                Controls.Label { text: qsTr("Stable storage: %1%2").arg(route.storageIdentity || qsTr("not available")).arg(route.filesystemType ? qsTr(" · %1").arg(route.filesystemType) : ""); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text }
                Controls.Label { visible: route.jobState === "Waiting"; text: qsTr("Waiting for this exact storage to reconnect. No transfer starts and no folders are created while it is offline."); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
            }
        }
    }
    function showOnboardingIfNeeded() {
        if (onboardingDeviceId.length > 0 || onboardingDialog.visible || setupModel.firstSeenDevices.length === 0) return
        onboardingDeviceId = setupModel.firstSeenDevices[0].id
        hideOnboarding.checked = false
        onboardingDialog.open()
    }
    function finishOnboarding(hide) {
        const deviceId = onboardingDeviceId
        if (deviceId.length === 0) return
        onboardingDeviceId = ""
        setupModel.acknowledgeDevice(deviceId, hide)
        onboardingDialog.close()
        Qt.callLater(showOnboardingIfNeeded)
    }
    function openWirelessSettingsFromOnboarding() {
        finishOnboarding(false)
        currentMode = "New"
        settingsContentIndex = 0
        showingSettings = true
    }
    Shortcut { sequence: "Ctrl+R"; onActivated: refreshAll() }
    Shortcut { sequence: "Ctrl+S"; onActivated: saveCurrentRoute() }
    Shortcut { sequence: "Ctrl+Enter"; onActivated: startSelectedRoute() }
    Shortcut { sequence: "Esc"; onActivated: if (copyEngine.running) copyEngine.cancel() }
    Shortcut { sequence: "Alt+1"; onActivated: { currentMode = "Sync"; showingSettings = false } }
    Shortcut { sequence: "Alt+2"; onActivated: { currentMode = "Drive"; showingSettings = false } }
    Shortcut { sequence: "Alt+3"; onActivated: { currentMode = "Photos"; showingSettings = false } }
    Shortcut { sequence: "Alt+4"; onActivated: { currentMode = "New"; showingSettings = false } }
    Timer { id: resumeTimer; repeat: false; onTriggered: {
        if (!copyEngine.paused) { pauseRemainingMilliseconds = 0; return }
        pauseRemainingMilliseconds -= interval
        if (pauseRemainingMilliseconds <= 0) { pauseRemainingMilliseconds = 0; copyEngine.resume() }
        else scheduleResumeTimer()
    } }
    header: Controls.ToolBar {
        visible: copyEngine.running
        height: visible ? implicitHeight : 0
        contentItem: ColumnLayout {
            spacing: Kirigami.Units.smallSpacing
            RowLayout {
                Layout.fillWidth: true
                Controls.Label {
                    text: qsTr("%1 · %2").arg(copyEngine.status).arg(activeRoute.destination || qsTr("selected route"))
                    elide: Text.ElideMiddle
                    Layout.fillWidth: true
                    Accessible.name: text
                }
                Controls.Button {
                    text: copyEngine.paused ? qsTr("Resume") : qsTr("Pause")
                    enabled: copyEngine.status === "Copying" || copyEngine.paused
                    onClicked: copyEngine.paused ? resumeTransfer() : pauseDialog.open()
                    Accessible.name: text
                }
                Controls.Button {
                    text: qsTr("Cancel")
                    enabled: ["Previewing", "Copying", "Pausing", "Paused", "Resuming", "Moving verified sources to Trash"].indexOf(copyEngine.status) >= 0
                    onClicked: copyEngine.cancel()
                    Accessible.name: text
                }
            }
            RowLayout {
                Layout.fillWidth: true
                Controls.ProgressBar {
                    value: transferProgress
                    Layout.fillWidth: true
                    Accessible.name: qsTr("Transfer progress")
                }
                Controls.Label {
                    text: qsTr("%1%").arg(Math.round(transferProgress * 100))
                    Accessible.name: text
                }
            }
            Controls.Label {
                visible: transferPath.length > 0
                text: qsTr("Current file: %1").arg(transferPath)
                elide: Text.ElideMiddle
                Layout.fillWidth: true
                Accessible.name: text
            }
        }
    }
    footer: Controls.ToolBar {
        contentItem: RowLayout {
            Controls.Button { text: qsTr("Sync"); checkable: true; checked: currentMode === "Sync" && !showingSettings; onClicked: { currentMode = "Sync"; showingSettings = false } Accessible.name: qsTr("Sync"); Layout.fillWidth: true }
            Controls.Button { text: qsTr("Drive"); checkable: true; checked: currentMode === "Drive" && !showingSettings; onClicked: { currentMode = "Drive"; showingSettings = false } Accessible.name: qsTr("Drive"); Layout.fillWidth: true }
            Controls.Button { text: qsTr("Photos"); checkable: true; checked: currentMode === "Photos" && !showingSettings; onClicked: { currentMode = "Photos"; showingSettings = false } Accessible.name: qsTr("Photos"); Layout.fillWidth: true }
            Controls.Button { text: qsTr("New +"); checkable: true; checked: currentMode === "New" && !showingSettings; onClicked: { currentMode = "New"; showingSettings = false } Accessible.name: qsTr("New"); Layout.fillWidth: true }
        }
    }
    pageStack.initialPage: Kirigami.ScrollablePage {
        title: showingSettings ? qsTr("Settings") : currentMode === "Sync" ? qsTr("Sync") : currentMode === "Drive" ? qsTr("Drive") : currentMode === "Photos" ? qsTr("Photos") : qsTr("New")
        StackLayout { id: modeStack; width: parent.width; currentIndex: modeIndex()
        ColumnLayout { width: parent.width; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("Computer and storage"); level: 2 }
            Kirigami.Card { Layout.fillWidth: true; visible: copyEngine.logEntries.length > 0
                header: Controls.Label { text: qsTr("Live log"); Accessible.name: text }
                contentItem: ColumnLayout {
                    Repeater { model: copyEngine.logEntries.slice(Math.max(0, copyEngine.logEntries.length - 12)); delegate: Controls.Label { text: modelData; elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text } }
                }
            }
            Kirigami.Card { Layout.fillWidth: true
                header: Controls.Label { text: qsTr("Computer — %1").arg(setupModel.localDeviceName); Accessible.name: text }
                contentItem: Controls.Label { text: qsTr("Present · catalog %1").arg(setupModel.ready ? qsTr("ready") : qsTr("not ready")); Accessible.name: text }
            }
            Controls.Label { text: setupModel.ready ? qsTr("Catalog ready") : qsTr("Catalog not ready: %1").arg(setupModel.errorMessage); color: setupModel.ready ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.negativeTextColor; Accessible.name: text }
            Controls.Label { visible: setupModel.ready && setupModel.errorMessage.length > 0; text: qsTr("Could not save: %1").arg(setupModel.errorMessage); color: Kirigami.Theme.negativeTextColor; Accessible.name: text }
            Kirigami.Heading { text: qsTr("Connection map"); level: 3 }
            Repeater { model: setupModel.routes; delegate: routeMapCard }
            Controls.Label { visible: setupModel.routes.length === 0; text: qsTr("No routes saved yet. The map will fill as Drive and Photos routes are configured."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Kirigami.Card { Layout.fillWidth: true
                header: Controls.Label { text: qsTr("Devices"); Accessible.name: text }
                contentItem: ColumnLayout {
                    Repeater { model: setupModel.deviceList; delegate: RowLayout { Layout.fillWidth: true
                        Controls.Label { text: modelData.label; font.bold: true; Layout.fillWidth: true; Accessible.name: text }
                        Controls.Label { text: modelData.status || qsTr("Online"); Accessible.name: text }
                        Controls.Label { text: (modelData.transports || []).join(" + "); Accessible.name: text }
                        Controls.Button { visible: modelData.wirelessCandidate === true && setupModel.mtpDevices.length === 1; text: qsTr("Pair with USB phone"); onClicked: setupModel.pairWirelessDevice(modelData.id, setupModel.mtpDevices[0].id); Accessible.name: qsTr("Pair wireless device with USB phone") }
                    } }
                    Controls.Label { visible: setupModel.deviceList.length === 0; text: qsTr("No phone or wireless device detected."); Accessible.name: text }
                }
            }
            Controls.Button { text: qsTr("Refresh devices"); enabled: setupModel.ready; Accessible.name: qsTr("Refresh devices"); onClicked: refreshAll() }
            Controls.Label { text: qsTr("Keyboard: Ctrl+R refresh · Ctrl+S save route · Ctrl+Enter start selected route · Esc stop active transfer"); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Computer → %1: %2").arg(selectedStorageLabel()).arg(routeDescription()); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Kirigami.Card { Layout.fillWidth: true
                header: Controls.Label { text: qsTr("Storage — %1").arg(selectedStorageLabel()); Accessible.name: text }
                contentItem: Controls.Label { text: storage.currentIndex < 0 ? qsTr("No external storage detected") : (!setupModel.storages[storage.currentIndex + 1].present ? qsTr("Missing") : qsTr("Present") + (setupModel.storages[storage.currentIndex + 1].filesystemType ? qsTr(" · %1").arg(setupModel.storages[storage.currentIndex + 1].filesystemType) : "")); Accessible.name: text }
            }
            Kirigami.Card { Layout.fillWidth: true; visible: setupModel.connectedDevices.length > 0
                header: Controls.Label { text: qsTr("Phone — %1").arg(connectedPhone.label || setupModel.mtpDeviceLabel); Accessible.name: text }
                contentItem: ColumnLayout {
                    Controls.Label { text: qsTr("%1 · %2. Detection alone never starts a transfer.").arg(connectedPhone.status || qsTr("Online")).arg((connectedPhone.transports || []).join(" + ")); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                    RowLayout {
                        Controls.Button { text: qsTr("Drive → Drive"); enabled: !copyEngine.running && connectedPhone.url !== undefined; onClicked: openPhoneActions(); Accessible.name: qsTr("Import phone Drive to Drive") }
                        Controls.Button { text: qsTr("DCIM → Photos"); enabled: !copyEngine.running && connectedPhone.url !== undefined; onClicked: openPhoneActions(); Accessible.name: qsTr("Import phone DCIM to Photos") }
                    }
                }
            }
            Controls.Label { text: qsTr("Choose folders and the Keep policy. Keep Everything is the safe default; Keep Nothing moves sources to Trash only after verified transfer and confirmation."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Source folder"); Accessible.name: text }
            RowLayout { Layout.fillWidth: true
                Controls.TextField { id: source; placeholderText: "/path/to/source"; Layout.fillWidth: true; Accessible.name: qsTr("Source folder path") }
                Controls.Button { text: qsTr("Choose…"); Accessible.name: qsTr("Choose source folder"); onClicked: sourceDialog.open() }
            }
            Controls.Label { text: qsTr("Content root"); Accessible.name: text }
            Controls.ComboBox { id: contentType; model: [qsTr("Drive — files"), qsTr("Photos — photos and videos")]; currentIndex: 0; Layout.fillWidth: true; Accessible.name: qsTr("Content root") }
            Controls.Label { text: qsTr("Destination storage"); Accessible.name: text }
            Controls.ComboBox { id: storage; model: setupModel.storages.slice(1); textRole: "label"; valueRole: "id"; currentIndex: 0; Layout.fillWidth: true; Accessible.name: qsTr("Destination storage") }
            Controls.Label { text: qsTr("Destination folder"); Accessible.name: text }
            RowLayout { Layout.fillWidth: true
                Controls.TextField { id: destination; placeholderText: "/path/on/storage"; Layout.fillWidth: true; Accessible.name: qsTr("Destination folder path") }
                Controls.Button { text: qsTr("Choose…"); Accessible.name: qsTr("Choose destination folder"); onClicked: destinationDialog.open() }
            }
            Controls.Label { text: qsTr("Optional laptop staging folder"); Accessible.name: text }
            RowLayout { Layout.fillWidth: true
                Controls.TextField { id: stagingRoot; placeholderText: qsTr("Leave empty to disable staging"); Layout.fillWidth: true; Accessible.name: qsTr("Optional laptop staging folder path") }
                Controls.Button { text: qsTr("Choose…"); Accessible.name: qsTr("Choose staging folder"); onClicked: stagingDialog.open() }
            }
            Controls.Label { text: qsTr("Keep policy"); Accessible.name: text }
            Controls.ComboBox { id: keepPolicy; model: [qsTr("Keep Everything"), qsTr("Keep Last month"), qsTr("Keep Last week"), qsTr("Keep Last day"), qsTr("Keep Nothing")]; currentIndex: 0; Layout.fillWidth: true; Accessible.name: qsTr("Keep policy") }
            Controls.Label { text: qsTr("Minimum free space (MiB)"); Accessible.name: text }
            Controls.SpinBox { id: minimumFreeSpace; from: 0; to: 1048576; value: 0; editable: true; Layout.fillWidth: true; Accessible.name: qsTr("Minimum free space in MiB") }
            Controls.Label { text: qsTr("Staging maximum per job (MiB)"); Accessible.name: text }
            Controls.SpinBox { id: stagingMaximum; from: 0; to: 1048576; value: 0; editable: true; Layout.fillWidth: true; Accessible.name: qsTr("Staging maximum per job in MiB") }
            Controls.Label { text: qsTr("A non-zero staging maximum rejects a preview whose new bytes exceed this per-job intake bound; zero means unlimited."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.CheckBox { id: organizePhotos; visible: contentType.currentIndex === 1; text: qsTr("Organize unfiled photos by capture year"); Accessible.name: qsTr("Organize unfiled photos by capture year") }
            Controls.Label { visible: contentType.currentIndex === 1; text: qsTr("Optional: unfiled media goes to Local Drive/Photos/year; meaningful folders and paired sidecars stay together."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { id: saveRouteButton; text: qsTr("Save route policy"); enabled: setupModel.ready && storage.currentIndex >= 0 && source.text.length > 0 && destination.text.length > 0; Accessible.name: qsTr("Save route policy"); onClicked: saveCurrentRoute() }
            Kirigami.Heading { text: qsTr("Saved routes"); level: 2 }
            Repeater { model: setupModel.routes; delegate: Kirigami.Card { Layout.fillWidth: true
                contentItem: ColumnLayout {
                    Controls.Label { text: qsTr("[%1] %2 → %3: %4").arg(modelData.contentType).arg(modelData.source).arg(modelData.destination).arg(keepPolicyDescription(modelData.keepPolicy) + (modelData.stagingRoot.length > 0 ? qsTr(" · staging %1").arg(modelData.stagingRoot) : "") + (modelData.stagingMaxBytes > 0 ? qsTr(" · staging max %1 MiB/job").arg(Math.round(modelData.stagingMaxBytes / 1048576)) : "") + (modelData.minimumFreeBytes > 0 ? qsTr(" · safety margin %1 MiB").arg(Math.round(modelData.minimumFreeBytes / 1048576)) : "") + (modelData.organizePhotos ? qsTr(" · photos by year") : "")); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { visible: modelData.jobState !== undefined && modelData.jobState.length > 0; text: modelData.jobError.length > 0 ? qsTr("Last job: %1 — %2%3%4").arg(modelData.jobState).arg(modelData.jobErrorCode.length > 0 ? modelData.jobErrorCode + " — " : "").arg(modelData.jobError).arg(modelData.jobErrorCode.length > 0 ? qsTr(" Source remains safe. %1").arg(errorNextAction(modelData.jobErrorCode)) : "") : qsTr("Last job: %1").arg(modelData.jobState); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { visible: modelData.jobState === "Waiting"; text: qsTr("Waiting for the exact storage to reconnect. No transfer starts and no folders are created while it is offline."); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    RowLayout {
                        Controls.Button { text: qsTr("Preview"); enabled: !copyEngine.running; onClicked: { previewRouteId = modelData.id; copyEngine.previewRoute(modelData.id) } }
                        Controls.Button { text: qsTr("Export manifest"); enabled: previewRouteId === modelData.id && selectedPreview.ok === true && !copyEngine.running; onClicked: { manifestStatus = ""; manifestDialog.open() } }
                        Controls.Button { text: modelData.keepPolicy === "Nothing" ? qsTr("Start verified transfer") : qsTr("Start verified copy"); enabled: previewRouteId === modelData.id && selectedPreview.ok === true && copyEngine.previewSuccessful && !copyEngine.running; onClicked: copyEngine.startCopy() }
                        Controls.Button { text: modelData.keepPolicy === "Nothing" ? qsTr("Move verified sources to Trash") : qsTr("Move expired sources to Trash"); visible: modelData.keepPolicy !== "Everything"; enabled: previewRouteId === modelData.id && copyEngine.cleanupReady && !copyEngine.running; onClicked: cleanupDialog.open() }
                    }
                    Controls.Label { visible: previewRouteId === modelData.id && (selectedPreview.ok === true || selectedPreview.unreadable > 0); text: qsTr("Preview: %1 files · %2 bytes · to copy %3 · identical %4 · duplicates %5 · organized %6 · conflicts %7 · unsupported %8 · unreadable %9 · free %10 · safety margin %11").arg(selectedPreview.files).arg(selectedPreview.bytes).arg(selectedPreview.toCopy).arg(selectedPreview.identical).arg(selectedPreview.duplicates).arg(selectedPreview.organized).arg(selectedPreview.conflicts).arg(selectedPreview.unsupported).arg(selectedPreview.unreadable).arg(selectedPreview.freeBytes).arg(selectedPreview.minimumFreeBytes); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { visible: previewRouteId === modelData.id && selectedPreview.ok === true && selectedPreview.conflicts > 0; text: qsTr("Conflict paths: %1").arg(selectedPreview.conflictPaths.slice(0, 5).join(", ") + (selectedPreview.conflicts > 5 ? qsTr(" …") : "")); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { visible: previewRouteId === modelData.id && copyEngine.cleanupReady; text: selectedCleanup.uncertain === true ? qsTr("Cleanup outcome is uncertain: review system Trash and catalog before retrying.") : (selectedCleanup.files === 0 ? qsTr("Cleanup preview: no eligible source files") : qsTr("Cleanup preview: %1 files · %2 bytes eligible for Trash").arg(selectedCleanup.files).arg(selectedCleanup.bytes)); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { visible: previewRouteId === modelData.id && selectedPreview.ok === false && selectedPreview.error !== undefined && selectedPreview.error.length > 0; text: qsTr("Preview failed: %1%2 Source unchanged. %3").arg(selectedPreview.errorCode !== undefined && selectedPreview.errorCode.length > 0 ? "[" + selectedPreview.errorCode + "] " : "").arg(selectedPreview.error).arg(selectedPreview.nextAction !== undefined ? selectedPreview.nextAction : qsTr("Fix the reported problem, then preview again.")); color: Kirigami.Theme.negativeTextColor; wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { visible: previewRouteId === modelData.id && manifestStatus.length > 0; text: manifestStatus; wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { visible: previewRouteId === modelData.id && selectedHistory.length > 0; text: qsTr("Recent history"); Layout.fillWidth: true; Accessible.name: text }
                    Repeater { model: previewRouteId === modelData.id ? selectedHistory : []; delegate: Controls.Label { text: qsTr("%1 · %2").arg(modelData.event).arg(modelData.result); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text } }
                }
            } }
        }
        ColumnLayout { width: parent.width; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("Drive"); level: 2 }
            Controls.Label { text: qsTr("Ordinary files in the configured Drive root. The verified route actions remain available from Sync."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Kirigami.Card { Layout.fillWidth: true
                header: Controls.Label { text: qsTr("Drive files"); Accessible.name: text }
                contentItem: ColumnLayout {
                    Repeater { model: setupModel.routes.filter(function(route) { return route.contentType === "Drive" }); delegate: Controls.Label { text: qsTr("%1 → %2 · %3").arg(modelData.source).arg(modelData.destination).arg(modelData.keepPolicy); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text } }
                    Controls.Label { visible: setupModel.routes.filter(function(route) { return route.contentType === "Drive" }).length === 0; text: qsTr("No Drive route saved yet."); Accessible.name: text }
                }
            }
        }
        ColumnLayout { width: parent.width; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("Photos"); level: 2 }
            Controls.Label { text: qsTr("Photos and videos in the configured Photos root. The library stays ordinary files and remains editable by normal applications."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Kirigami.Card { Layout.fillWidth: true
                header: Controls.Label { text: qsTr("Photos routes"); Accessible.name: text }
                contentItem: ColumnLayout {
                    Repeater { model: setupModel.routes.filter(function(route) { return route.contentType === "Photos" }); delegate: Controls.Label { text: qsTr("%1 → %2 · %3").arg(modelData.source).arg(modelData.destination).arg(modelData.keepPolicy); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text } }
                    Controls.Label { visible: setupModel.routes.filter(function(route) { return route.contentType === "Photos" }).length === 0; text: qsTr("No Photos route saved yet."); Accessible.name: text }
                }
            }
        }
        ColumnLayout { width: parent.width; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("New"); level: 2 }
            Controls.Label { text: qsTr("Start a focused task. These actions keep the same keyboard-first workflow and do not silently start a transfer."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { text: qsTr("Sync now"); onClicked: currentMode = "Sync"; Accessible.name: qsTr("Sync now") }
            Controls.Button { text: qsTr("New folder"); enabled: false; Accessible.name: qsTr("New folder") }
            Controls.Button { text: qsTr("Scan document"); enabled: false; Accessible.name: qsTr("Scan document") }
            Controls.Button { text: qsTr("Settings"); onClicked: showingSettings = true; Accessible.name: qsTr("Settings") }
        }
        ColumnLayout { width: parent.width; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("Settings"); level: 2 }
            Controls.Label { text: qsTr("Settings preserves the same storage identities, routes, and history. Changes here do not delete files."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Kirigami.Heading { text: qsTr("Visual connection map"); level: 3 }
            Controls.Label { text: qsTr("These are two filters over the same remembered devices and storage. A disk can serve both maps."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.TabBar {
                id: settingsContentTabs
                currentIndex: settingsContentIndex
                onCurrentIndexChanged: settingsContentIndex = currentIndex
                Layout.fillWidth: true
                Controls.TabButton { text: qsTr("Drive"); Accessible.name: qsTr("Drive map") }
                Controls.TabButton { text: qsTr("Photos"); Accessible.name: qsTr("Photos map") }
            }
            StackLayout {
                currentIndex: settingsContentIndex
                Layout.fillWidth: true
                ColumnLayout {
                    Kirigami.Heading { text: qsTr("Drive routes"); level: 4 }
                    Repeater { model: setupModel.routes.filter(function(route) { return route.contentType === "Drive" }); delegate: routeMapCard }
                    Controls.Label { visible: setupModel.routes.filter(function(route) { return route.contentType === "Drive" }).length === 0; text: qsTr("No Drive route saved yet."); Accessible.name: text }
                }
                ColumnLayout {
                    Kirigami.Heading { text: qsTr("Photos routes"); level: 4 }
                    Repeater { model: setupModel.routes.filter(function(route) { return route.contentType === "Photos" }); delegate: routeMapCard }
                    Controls.Label { visible: setupModel.routes.filter(function(route) { return route.contentType === "Photos" }).length === 0; text: qsTr("No Photos route saved yet."); Accessible.name: text }
                }
            }
            Kirigami.Heading { text: qsTr("Wireless receiver"); level: 3 }
            Kirigami.Card {
                Layout.fillWidth: true
                contentItem: ColumnLayout {
                    Controls.Label { text: qsTr("The receiver accepts only TLS 1.3 clients whose certificate fingerprint is pinned. A successful Start is remembered locally and starts again with the application; Stop disables that auto-start."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { text: qsTr("Status: %1").arg(wirelessReceiver.status); Layout.fillWidth: true; Accessible.name: text }
                    RowLayout { Layout.fillWidth: true
                        Controls.TextField { id: receiverDestination; placeholderText: qsTr("Local Drive root / destination folder"); Layout.fillWidth: true; Accessible.name: qsTr("Wireless destination root") }
                        Controls.Button { text: qsTr("Choose…"); onClicked: receiverDestinationDialog.open(); Accessible.name: qsTr("Choose wireless destination root") }
                    }
                    RowLayout { Layout.fillWidth: true
                        Controls.TextField { id: receiverCertificate; placeholderText: qsTr("Server certificate PEM"); Layout.fillWidth: true; Accessible.name: qsTr("Server certificate") }
                        Controls.Button { text: qsTr("Choose…"); onClicked: receiverCertificateDialog.open(); Accessible.name: qsTr("Choose server certificate") }
                    }
                    RowLayout { Layout.fillWidth: true
                        Controls.TextField { id: receiverPrivateKey; placeholderText: qsTr("Server private key PEM"); Layout.fillWidth: true; Accessible.name: qsTr("Server private key") }
                        Controls.Button { text: qsTr("Choose…"); onClicked: receiverPrivateKeyDialog.open(); Accessible.name: qsTr("Choose server private key") }
                    }
                    RowLayout { Layout.fillWidth: true
                        Controls.TextField { id: receiverClientCa; placeholderText: qsTr("Android client certificate PEM"); Layout.fillWidth: true; Accessible.name: qsTr("Android client certificate") }
                        Controls.Button { text: qsTr("Choose…"); onClicked: receiverClientCaDialog.open(); Accessible.name: qsTr("Choose Android client certificate") }
                    }
                    RowLayout { Layout.fillWidth: true
                        Controls.TextField { id: receiverFingerprint; placeholderText: qsTr("Pinned Android SHA-256 fingerprint"); Layout.fillWidth: true; Accessible.name: qsTr("Pinned Android certificate fingerprint") }
                        Controls.TextField { id: receiverPort; text: "43171"; inputMethodHints: Qt.ImhDigitsOnly; width: 100; Accessible.name: qsTr("Wireless receiver port") }
                    }
                    RowLayout { Layout.fillWidth: true
                        Controls.Button { text: qsTr("Start receiver"); enabled: !wirelessReceiver.listening; onClicked: wirelessReceiver.start(receiverDestination.text, receiverCertificate.text, receiverPrivateKey.text, receiverClientCa.text, receiverFingerprint.text, Number(receiverPort.text)); Accessible.name: qsTr("Start wireless receiver") }
                        Controls.Button { text: qsTr("Stop receiver"); enabled: wirelessReceiver.listening; onClicked: wirelessReceiver.stop(); Accessible.name: qsTr("Stop wireless receiver") }
                    }
                    Controls.Label { text: qsTr("Live receiver log"); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
                    Repeater { model: wirelessReceiver.logEntries.slice(Math.max(0, wirelessReceiver.logEntries.length - 12)); delegate: Controls.Label { text: modelData; elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text } }
                }
            }
            Kirigami.Heading { text: qsTr("Hidden devices"); level: 3 }
            Controls.Label { text: qsTr("Hidden devices stay in the catalog and history. Show one again when you want it back in the map and device list."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Repeater { model: setupModel.hiddenDevices; delegate: RowLayout { Layout.fillWidth: true
                Controls.Label { text: qsTr("%1 · %2").arg(modelData.label).arg(modelData.stableIdentity); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text }
                Controls.Button { text: qsTr("Show again"); onClicked: setupModel.showDevice(modelData.id); Accessible.name: qsTr("Show %1 again").arg(modelData.label) }
            } }
            Controls.Label { visible: setupModel.hiddenDevices.length === 0; text: qsTr("No hidden devices."); Accessible.name: text }
            Controls.Button { text: qsTr("Back to New"); onClicked: { showingSettings = false; currentMode = "New" } Accessible.name: qsTr("Back to New") }
        }
        }
    }
    Connections { target: copyEngine; function onPreviewChanged() { selectedPreview = copyEngine.previewData; selectedCleanup = copyEngine.cleanupPreview(); selectedHistory = copyEngine.recentHistory(); transferProgress = 0; transferPath = "" } function onProgressChanged(done, total, path) { transferProgress = total > 0 ? done / total : 0; transferPath = path } function onFinished() { resumeTimer.stop(); pauseRemainingMilliseconds = 0; setupModel.refreshRoutes(); selectedCleanup = copyEngine.cleanupPreview(); selectedHistory = copyEngine.recentHistory(); transferProgress = 0; transferPath = "" } }
    Connections { target: setupModel; function onChanged() { showOnboardingIfNeeded() } }
    FolderDialog { id: sourceDialog; title: qsTr("Choose source folder"); onAccepted: source.text = setupModel.pathFromUrl(selectedFolder) }
    FolderDialog { id: destinationDialog; title: qsTr("Choose destination folder"); currentFolder: storage.currentIndex >= 0 ? "file://" + setupModel.storages[storage.currentIndex + 1].root : ""; onAccepted: destination.text = setupModel.pathFromUrl(selectedFolder) }
    FolderDialog { id: stagingDialog; title: qsTr("Choose laptop staging folder"); onAccepted: stagingRoot.text = setupModel.pathFromUrl(selectedFolder) }
    FolderDialog { id: receiverDestinationDialog; title: qsTr("Choose wireless destination root"); onAccepted: receiverDestination.text = setupModel.pathFromUrl(selectedFolder) }
    FileDialog { id: receiverCertificateDialog; title: qsTr("Choose server certificate"); fileMode: FileDialog.OpenFile; onAccepted: receiverCertificate.text = setupModel.pathFromUrl(selectedFile) }
    FileDialog { id: receiverPrivateKeyDialog; title: qsTr("Choose server private key"); fileMode: FileDialog.OpenFile; onAccepted: receiverPrivateKey.text = setupModel.pathFromUrl(selectedFile) }
    FileDialog { id: receiverClientCaDialog; title: qsTr("Choose Android client certificate"); fileMode: FileDialog.OpenFile; onAccepted: receiverClientCa.text = setupModel.pathFromUrl(selectedFile) }
    FileDialog { id: manifestDialog; title: qsTr("Export manifest"); fileMode: FileDialog.SaveFile; nameFilters: [qsTr("JSON manifest (*.json)"), qsTr("CSV manifest (*.csv)")]; onAccepted: { const format = selectedFile.toString().toLowerCase().endsWith(".csv") ? "csv" : "json"; manifestStatus = copyEngine.exportManifest(selectedFile, format) ? qsTr("Manifest exported") : qsTr("Could not export manifest"); } }
    Controls.Dialog { id: pauseDialog; title: qsTr("Pause transfer"); modal: true; width: 560; standardButtons: Controls.Dialog.NoButton
        contentItem: ColumnLayout {
            Controls.Label { text: qsTr("Choose a value from 1 to 99 and a time unit. The application resumes the transfer only while it stays open; closing the application leaves no background service."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            RowLayout {
                Controls.Label { text: qsTr("Duration"); Accessible.name: text }
                Controls.Tumbler { id: pauseAmount; model: 99; currentIndex: 2; visibleItemCount: 5; width: 84; height: 150; Accessible.name: qsTr("Pause duration from 1 to 99")
                    delegate: Controls.Label { text: modelData + 1; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; width: pauseAmount.width; height: pauseAmount.height / pauseAmount.visibleItemCount; Accessible.name: text }
                }
                Controls.Tumbler { id: pauseUnit; model: [qsTr("minutes"), qsTr("hours"), qsTr("days")]; currentIndex: 1; visibleItemCount: 3; width: 120; height: 150; Accessible.name: qsTr("Pause time unit")
                    delegate: Controls.Label { text: modelData; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; width: pauseUnit.width; height: pauseUnit.height / pauseUnit.visibleItemCount; Accessible.name: text }
                }
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                Controls.Button { text: qsTr("Cancel"); onClicked: pauseDialog.close(); Accessible.name: qsTr("Cancel pause") }
                Controls.Button { text: qsTr("Start pause with these options"); onClicked: { pauseTransferFor(pauseDurationMilliseconds()); pauseDialog.close() } Accessible.name: qsTr("Start pause with selected duration") }
            }
        }
    }
    Controls.Dialog { id: cleanupDialog; title: qsTr("Move verified sources to Trash?"); modal: true; width: 560; standardButtons: Controls.Dialog.Ok | Controls.Dialog.Cancel
        contentItem: Controls.Label { text: selectedCleanup.uncertain === true ? qsTr("The previous cleanup outcome may have reached Trash before the catalog was updated. Review Trash and the catalog before retrying; the app will not mark it complete automatically.") : (selectedCleanup.files === 0 ? qsTr("No source files are currently eligible for Trash. The policy will be rechecked safely.") : qsTr("Move %1 verified files (%2 bytes) to the system Trash? They remain recoverable there.").arg(selectedCleanup.files).arg(selectedCleanup.bytes)); wrapMode: Text.WordWrap; padding: Kirigami.Units.largeSpacing; Accessible.name: text }
        onAccepted: copyEngine.cleanup()
    }
    Controls.Dialog { id: onboardingDialog; modal: true; width: 620; closePolicy: Controls.Popup.CloseOnEscape
        header: RowLayout {
            Controls.Label { text: onboardingDevice.category === "storage" ? qsTr("New storage detected") : qsTr("New device detected"); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { text: qsTr("✕"); flat: true; Accessible.name: qsTr("Close"); onClicked: finishOnboarding(false) }
        }
        contentItem: ColumnLayout {
            Controls.Label { text: onboardingDevice.label || qsTr("Unknown device"); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.category === "storage"; text: qsTr("Stable identity: %1").arg(onboardingDevice.stableIdentity || qsTr("not available")); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.category === "storage"; text: qsTr("Filesystem: %1 · selected root: %2").arg(onboardingDevice.filesystemType || qsTr("unknown")).arg(onboardingDevice.root || qsTr("not available")); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.category === "storage"; text: qsTr("Choose its role and the Drive/Photos roots in the connection map. Local Drive will never format this storage automatically."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.kind === "Phone"; text: qsTr("Phone setup: unlock Android and select USB mode ‘File transfer / MTP’. Local Drive uses the fixed phone roots Drive/ for files and DCIM/ for photos and videos."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.kind === "Phone"; text: qsTr("Available actions after setup: Drive → Drive and DCIM → Photos. Detection alone never starts a transfer. Wireless pairing uses the Android profile exchange and the Wireless receiver panel in Settings."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.wirelessCandidate === true; text: qsTr("Wireless setup — 1) On Android, import the Linux receiver profile and share the Android public certificate back. 2) In Settings, choose the destination and certificate files, then pin the Android SHA-256 fingerprint. 3) Start the receiver. 4) Keep both devices on the same LAN and let the phone connect. Discovery only finds the phone; it never grants file access."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { visible: onboardingDevice.wirelessCandidate === true; text: qsTr("Open Wireless receiver settings"); Layout.alignment: Qt.AlignLeft; onClicked: openWirelessSettingsFromOnboarding(); Accessible.name: qsTr("Open Wireless receiver settings") }
            Controls.Label { visible: onboardingDevice.wirelessCandidate === true; text: qsTr("If this is the same phone as a USB device, select it below and pair explicitly so the list keeps one device with both transports. The Alpha setup uses JSON profile exchange; automatic QR certificate onboarding is not enabled yet."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.ComboBox { id: wirelessMtpTarget; visible: onboardingDevice.wirelessCandidate === true && setupModel.mtpDevices.length > 1; model: setupModel.mtpDevices; textRole: "label"; valueRole: "id"; Layout.fillWidth: true; Accessible.name: qsTr("Choose the USB phone matching this wireless phone") }
            Controls.Button { visible: onboardingDevice.wirelessCandidate === true && setupModel.mtpDevices.length > 0; text: qsTr("Pair with the selected USB phone"); Layout.alignment: Qt.AlignLeft; onClicked: { const targetId = setupModel.mtpDevices.length === 1 ? setupModel.mtpDevices[0].id : wirelessMtpTarget.currentValue; if (targetId && setupModel.pairWirelessDevice(onboardingDevice.id, targetId)) finishOnboarding(false) } Accessible.name: qsTr("Pair wireless candidate with the selected USB phone") }
            Controls.Label { visible: onboardingDevice.category !== "storage" && onboardingDevice.kind !== "Phone"; text: qsTr("Only detected capabilities are shown. Choose the matching pairing or storage step; Local Drive will not guess a server protocol."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.CheckBox { id: hideOnboarding; text: qsTr("Do not show this device again"); Accessible.name: qsTr("Do not show this device again") }
            Controls.Label { text: qsTr("X closes this guide without deleting the device, routes, or history. Hidden devices remain available in Settings."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { text: qsTr("Close"); Layout.alignment: Qt.AlignRight; onClicked: finishOnboarding(hideOnboarding.checked); Accessible.name: text }
        }
        onRejected: finishOnboarding(false)
        onClosed: if (onboardingDeviceId.length > 0) finishOnboarding(false)
    }
    Controls.Dialog { id: phoneActionDialog; modal: true; width: 620; closePolicy: Controls.Popup.CloseOnEscape
        header: RowLayout {
            Controls.Label { text: qsTr("Phone transfer"); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { text: qsTr("✕"); flat: true; Accessible.name: qsTr("Close"); onClicked: phoneActionDialog.close() }
        }
        contentItem: ColumnLayout {
            Controls.Label { text: qsTr("%1 · %2").arg(phoneActionDevice.label || qsTr("Phone")).arg(phoneActionDevice.stableIdentity || ""); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Detected storage root: %1").arg(phoneActionDevice.phoneRoot || qsTr("discovering…")); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Choose one action. Local Drive scans the fixed phone root, previews within the safety bound, then performs verified copies. Nothing is deleted from the phone."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Drive source: %1").arg(phoneSourceUrl("Drive")); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Photos source: %1").arg(phoneSourceUrl("DCIM")); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text }
            RowLayout {
                Controls.Button { text: qsTr("Start Drive → Drive"); enabled: !copyEngine.running; onClicked: startPhoneImport("Drive", "Drive"); Accessible.name: qsTr("Start Drive to Drive import") }
                Controls.Button { text: qsTr("Start DCIM → Photos"); enabled: !copyEngine.running; onClicked: startPhoneImport("Photos", "DCIM"); Accessible.name: qsTr("Start DCIM to Photos import") }
            }
            Controls.Label { visible: phoneActionStatus.length > 0; text: phoneActionStatus; color: Kirigami.Theme.negativeTextColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { text: qsTr("Cancel"); Layout.alignment: Qt.AlignRight; onClicked: phoneActionDialog.close(); Accessible.name: text }
        }
    }
    Component.onCompleted: {
        receiverDestination.text = wirelessReceiver.savedDestination
        receiverCertificate.text = wirelessReceiver.savedCertificate
        receiverPrivateKey.text = wirelessReceiver.savedPrivateKey
        receiverClientCa.text = wirelessReceiver.savedClientCa
        receiverFingerprint.text = wirelessReceiver.savedFingerprint
        receiverPort.text = wirelessReceiver.savedPort > 0 ? String(wirelessReceiver.savedPort) : "43171"
        if (wirelessReceiver.savedEnabled) wirelessReceiver.startSaved()
        showOnboardingIfNeeded()
    }
    onClosing: function(close) {
        if (!allowQuit && trayAvailable) {
            close.accepted = false
            hide()
        }
    }
}
