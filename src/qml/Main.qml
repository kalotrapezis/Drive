import QtQuick
import QtQuick.Controls as Controls
import QtQuick.Layouts
import QtQuick.Dialogs
import QtCore
import org.kde.kirigami as Kirigami

Kirigami.ApplicationWindow {
    visible: true
    property bool allowQuit: false
    property bool trayAvailable: true
    width: 900; height: 700
    minimumWidth: 900; minimumHeight: 640
    title: qsTr("Local Drive")
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
    property int settingsCategoryIndex: 0
    property int settingsConnectionIndex: 0
    property int setupStep: 1
    property int syncSectionIndex: 0
    property bool configuringRoute: false
    property var phoneActionDevice: ({})
    property var connectedPhone: setupModel.connectedDevices.length > 0 ? setupModel.connectedDevices[0] : ({})
    property string phoneActionStatus: ""
    property string pendingPairingProfilePath: ""
    property bool pendingPhonePhotos: false
    property var firstMapNode: ({})
    property var secondMapNode: ({})
    property string selectedMapContentType: "Drive"
    property string pendingSetupContentType: "Drive"
    property string pendingSetupKeepPolicy: "Everything"
    property bool pendingSetupBoth: true
    property bool pendingMountedStorageFlow: false
    property string pendingMountedStorageId: ""
    property double pauseRemainingMilliseconds: 0
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
    function homeRoot() {
        return decodeURIComponent(StandardPaths.writableLocation(StandardPaths.HomeLocation).toString().replace(/^file:\/\//, ""))
    }
    function isUnderHome(path) {
        const clean = path.length > 0 ? path.replace(/\/$/, "") : ""
        const home = homeRoot().replace(/\/$/, "")
        return clean === home || clean.indexOf(home + "/") === 0
    }
    function storageCandidates() {
        return setupModel.storages.slice(1).filter(function(item) {
            const label = (item.label || "").toLowerCase()
            const root = item.root || ""
            return label !== "efi" && label !== "system reserved" && root !== "/boot/efi" && root.indexOf("/boot/efi/") !== 0
        })
    }
    function bytesText(bytes) {
        if (bytes === undefined || Number(bytes) < 0) return qsTr("unknown")
        const units = ["B", "KB", "MB", "GB", "TB"]
        let value = Number(bytes), index = 0
        while (value >= 1024 && index < units.length - 1) { value /= 1024; ++index }
        return qsTr("%1 %2").arg(Math.round(value * 10) / 10).arg(units[index])
    }
    function storagePercent(item) {
        const total = Number(item.bytesTotal), free = Number(item.bytesFree)
        return total > 0 && free >= 0 ? Math.round((1 - free / total) * 100) : -1
    }
    function settingsMatches(label) {
        const term = settingsSearch.text.trim().toLowerCase()
        return term.length === 0 || label.toLowerCase().indexOf(term) >= 0
    }
    function storageLabel(storageId) {
        const items = setupModel.storages
        for (let index = 0; index < items.length; ++index) if (items[index].id === storageId) return items[index].label
        return qsTr("Storage")
    }
    function routeForSelectedNodes() {
        const storageNode = firstMapNode.kind === "storage" ? firstMapNode : (secondMapNode.kind === "storage" ? secondMapNode : ({}))
        if (storageNode.id === undefined) return ({})
        const routes = setupModel.routes.filter(function(route) { return route.storageId === storageNode.id && route.contentType === selectedMapContentType })
        return routes.length > 0 ? routes[0] : ({})
    }
    function selectMapNode(node, contentType) {
        selectedMapContentType = contentType
        if (firstMapNode.id === undefined || (firstMapNode.id === node.id && firstMapNode.kind === node.kind)) {
            firstMapNode = node
            secondMapNode = ({})
            return
        }
        secondMapNode = node
        const route = routeForSelectedNodes()
        relationshipSend.checked = true
        relationshipReceive.checked = false
        relationshipKeep.checked = route.id === undefined || route.keepPolicy !== "Nothing"
        relationshipStatus.text = ""
        relationshipDialog.open()
    }
    function applyRelationship() {
        const route = routeForSelectedNodes()
        const storageNode = firstMapNode.kind === "storage" ? firstMapNode : (secondMapNode.kind === "storage" ? secondMapNode : ({}))
        const hasLocal = firstMapNode.kind === "local" || secondMapNode.kind === "local"
        if (!hasLocal || storageNode.id === undefined) { relationshipStatus.text = qsTr("This alpha can apply a relationship only between this computer and backup storage."); return }
        if (!relationshipSend.checked || relationshipReceive.checked) { relationshipStatus.text = qsTr("This alpha supports Send to backup storage. Receive will be enabled for paired computers and servers."); return }
        if (route.id !== undefined) {
            if (setupModel.updateRouteRelationship(route.id, relationshipSend.checked, relationshipReceive.checked, relationshipKeep.checked)) relationshipDialog.close()
            else relationshipStatus.text = setupModel.errorMessage
            return
        }
        relationshipDialog.close()
        openRouteSetup(selectedMapContentType === "Drive" ? 0 : 1, storageNode.id, false,
                       relationshipKeep.checked ? "Everything" : "Nothing")
    }
    function notificationItems() {
        const items = []
        if (setupModel.routes.length === 0) items.push({title: qsTr("First setup is not finished"), detail: qsTr("Choose the computer library and a backup destination."), action: qsTr("Open setup"), target: "setup"})
        if (setupModel.connectedDevices.length > 0) items.push({title: qsTr("Phone detected"), detail: qsTr("%1 is ready for Files and Photos over %2.").arg(setupModel.connectedDevices[0].label).arg((setupModel.connectedDevices[0].transports || []).join(" + ")), action: qsTr("Open phone"), target: "phone"})
        const waiting = setupModel.routes.filter(function(route) { return route.jobState === "Waiting" })
        if (waiting.length > 0) items.push({title: qsTr("Backup storage is offline"), detail: qsTr("A saved route is waiting for its exact disk or server."), action: qsTr("Open map"), target: "map"})
        if (setupModel.errorMessage.length > 0) items.push({title: qsTr("Needs attention"), detail: setupModel.errorMessage, action: qsTr("Open settings"), target: "settings"})
        return items
    }
    function openDashboardAction(target) {
        if (target === "setup") openRouteSetup(0, "", setupModel.routes.length === 0)
        else if (target === "phone") openPhoneActions()
        else if (target === "map") { showingSettings = true; settingsCategoryIndex = 1 }
        else if (target === "settings") { showingSettings = true; settingsCategoryIndex = 2 }
    }
    function openRouteSetup(typeIndex, storageId, both, keepPolicy) {
        currentMode = "Sync"
        showingSettings = false
        syncSectionIndex = 0
        configuringRoute = true
        setupStep = both ? 1 : 2
        pendingSetupContentType = typeIndex === 0 ? "Drive" : "Photos"
        pendingSetupBoth = both
        pendingSetupKeepPolicy = keepPolicy || "Everything"
        source.text = ""
        destination.text = ""
        const options = storageCandidates()
        for (let index = 0; index < options.length; ++index) if (options[index].id === storageId) { storage.currentIndex = index; break }
        setupDialog.open()
    }
    function refreshAll() {
        if (!setupModel.ready) return
        setupModel.refreshStorages()
        setupModel.refreshMtpDevices()
        setupModel.startWirelessDiscovery()
        setupModel.refreshRoutes()
    }
    function saveCurrentRoute() {
        if (!saveRouteButton.enabled) return
        if (!isUnderHome(source.text)) return
        const save = function(type) { return setupModel.saveRoute(source.text, storage.currentValue, destination.text, pendingSetupKeepPolicy, 0, false, 0, "", type) }
        const saved = pendingSetupBoth ? setupModel.saveInitialRoutes(source.text, storage.currentValue, destination.text, "Everything", 0, false, 0, "") : save(pendingSetupContentType)
        if (saved) {
            const continueMountedFlow = pendingMountedStorageFlow && pendingSetupContentType === "Drive"
            setupStep = 1; configuringRoute = false; setupDialog.close(); syncSectionIndex = pendingSetupContentType === "Photos" ? 2 : 3
            if (continueMountedFlow) Qt.callLater(function() { moreRelationshipsDialog.open() })
        }
    }
    function startSelectedRoute() {
        if (copyEngine.running || previewRouteId.length === 0 || selectedPreview.ok !== true || !copyEngine.previewSuccessful) return
        copyEngine.startCopy()
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
    function startPhoneTransferAll() {
        if (firstRouteFor("Drive").id === undefined || firstRouteFor("Photos").id === undefined) {
            phoneActionStatus = qsTr("Save both a Files route and a Photos route first.")
            return
        }
        pendingPhonePhotos = true
        startPhoneImport("Drive", "Drive")
        if (!copyEngine.running) pendingPhonePhotos = false
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
                Controls.Label { visible: route.jobError && route.jobError.length > 0; text: qsTr("%1: %2\n%3").arg(route.jobState || qsTr("Problem")).arg(route.jobError).arg(errorNextAction(route.jobErrorCode)); wrapMode: Text.Wrap; Layout.fillWidth: true; color: Kirigami.Theme.negativeTextColor; Accessible.name: text }
                RowLayout {
                    Layout.fillWidth: true
                    Controls.Button { text: qsTr("Preview"); enabled: !copyEngine.running && route.storagePresent; onClicked: { previewRouteId = route.id; selectedPreview = ({}); manifestStatus = ""; copyEngine.previewRoute(route.id) } Accessible.name: qsTr("Preview transfer") }
                    Controls.Button { text: qsTr("Transfer"); enabled: !copyEngine.running && previewRouteId === route.id && selectedPreview.ok === true && copyEngine.previewSuccessful; onClicked: startSelectedRoute(); Accessible.name: qsTr("Start verified transfer") }
                    Controls.Button { text: qsTr("Export manifest"); enabled: previewRouteId === route.id && selectedPreview.ok === true && !copyEngine.running; onClicked: manifestDialog.open(); Accessible.name: qsTr("Export transfer manifest") }
                    Controls.Button { text: qsTr("Cleanup"); visible: route.keepPolicy !== "Everything"; enabled: !copyEngine.running && previewRouteId === route.id && copyEngine.cleanupReady; onClicked: cleanupDialog.open(); Accessible.name: qsTr("Move verified sources to Trash") }
                }
                Controls.Label { visible: previewRouteId === route.id && selectedPreview.ok === true; text: qsTr("Preview: %1 files · %2 bytes · %3 to transfer · %4 identical · %5 conflicts").arg(selectedPreview.files).arg(bytesText(selectedPreview.bytes)).arg(selectedPreview.toCopy).arg(selectedPreview.identical).arg(selectedPreview.conflicts); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                Controls.Label { visible: previewRouteId === route.id && selectedPreview.ok === false && selectedPreview.error; text: qsTr("Preview failed: %1").arg(selectedPreview.error); wrapMode: Text.Wrap; Layout.fillWidth: true; color: Kirigami.Theme.negativeTextColor; Accessible.name: text }
                Controls.Label { visible: previewRouteId === route.id && manifestStatus.length > 0; text: manifestStatus; Layout.fillWidth: true; Accessible.name: text }
                Controls.Label { visible: previewRouteId === route.id && selectedHistory.length > 0; text: qsTr("Recent: %1").arg(selectedHistory.slice(0, 3).map(function(entry) { return entry.event + " · " + entry.result }).join("\n")); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
            }
        }
    }
    Component {
        id: connectionMap
        ColumnLayout {
            property string mapContentType: "Drive"
            Layout.fillWidth: true
            Controls.Label { text: qsTr("Devices are nodes. Arrows are saved connections; the rule beside each arrow controls transfer direction and what remains on the source."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            RowLayout { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                Kirigami.Card { Layout.minimumWidth: 180; Layout.maximumWidth: 180; Layout.alignment: Qt.AlignTop
                    header: Controls.Label { text: qsTr("Devices"); font.bold: true; Accessible.name: text }
                    contentItem: ColumnLayout {
                        Controls.Button { text: qsTr("This computer"); checkable: true; checked: firstMapNode.id === "local" || secondMapNode.id === "local"; onClicked: selectMapNode({id: "local", kind: "local", label: setupModel.localDeviceName}, mapContentType); Layout.fillWidth: true; Accessible.name: qsTr("Select this computer") }
                        Kirigami.Card { Layout.fillWidth: true; contentItem: ColumnLayout {
                            Controls.CheckBox { id: hubEnabled; text: qsTr("Use as hub"); checked: setupModel.hubEnabled; Accessible.name: qsTr("Use laptop as hub") }
                            Controls.Label { text: qsTr("Keep usage below"); Accessible.name: text }
                            Controls.SpinBox { id: hubLimit; from: 1; to: 95; value: setupModel.hubLimitPercent; editable: true; textFromValue: function(value) { return value + "%" }; valueFromText: function(text) { return Number(text.replace("%", "")) }; Accessible.name: qsTr("Laptop hub storage limit") }
                            Controls.Button { text: qsTr("Apply"); onClicked: setupModel.setHubConfig(hubEnabled.checked, hubLimit.value); Accessible.name: qsTr("Apply laptop hub settings") }
                        } }
                        Repeater { model: setupModel.deviceList; delegate: Controls.Button { text: qsTr("%1  %2").arg(modelData.present ? "●" : "○").arg(modelData.label); checkable: true; checked: firstMapNode.id === modelData.id || secondMapNode.id === modelData.id; onClicked: selectMapNode({id: modelData.id, kind: "device", label: modelData.label}, mapContentType); Layout.fillWidth: true; Accessible.name: qsTr("Select %1").arg(modelData.label) } }
                        Repeater { model: storageCandidates(); delegate: Controls.Button { text: qsTr("%1  %2").arg(modelData.present ? "●" : "○").arg(modelData.label); checkable: true; checked: firstMapNode.id === modelData.id || secondMapNode.id === modelData.id; onClicked: selectMapNode({id: modelData.id, kind: "storage", label: modelData.label}, mapContentType); Layout.fillWidth: true; Accessible.name: qsTr("Select %1").arg(modelData.label) } }
                    }
                }
                ColumnLayout { Layout.fillWidth: true
                    Repeater { model: setupModel.routes.filter(function(route) { return route.contentType === mapContentType }); delegate: Kirigami.Card { Layout.fillWidth: true
                        contentItem: RowLayout { Layout.fillWidth: true
                            Kirigami.Card { Layout.preferredWidth: 170; contentItem: ColumnLayout { Controls.Label { text: qsTr("This computer"); font.bold: true; Accessible.name: text } Controls.Label { text: modelData.source; elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text } } }
                            ColumnLayout { Layout.preferredWidth: 230
                                Controls.Label { text: modelData.behavior === "Move" ? qsTr("→ verified move →") : qsTr("→ verified copy →"); font.bold: true; Layout.alignment: Qt.AlignHCenter; Accessible.name: text }
                                Controls.Label { text: qsTr("Send · Receive off · %1").arg(keepPolicyDescription(modelData.keepPolicy)); wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter; Layout.fillWidth: true; Accessible.name: text }
                            }
                            Kirigami.Card { Layout.fillWidth: true; contentItem: ColumnLayout { Controls.Label { text: storageLabel(modelData.storageId); font.bold: true; Accessible.name: text } Controls.Label { text: modelData.destination; elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text } Controls.Label { text: modelData.storagePresent ? qsTr("Online") : qsTr("Offline"); color: modelData.storagePresent ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.disabledTextColor; Accessible.name: text } } }
                        }
                    } }
                    Controls.Label { visible: setupModel.routes.filter(function(route) { return route.contentType === mapContentType }).length === 0; text: qsTr("No %1 connection exists yet. Open Setup to connect this computer to a storage device.").arg(mapContentType === "Drive" ? qsTr("Files") : qsTr("Photos")); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                }
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
    function deferOnboarding() {
        onboardingDeviceId = ""
        onboardingDialog.close()
    }
    function openWirelessSettingsFromOnboarding() {
        finishOnboarding(false)
        currentMode = "New"
        settingsCategoryIndex = 2
        settingsConnectionIndex = 1
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
    header: ColumnLayout {
        width: parent.width
        Controls.ToolBar { Layout.fillWidth: true
            contentItem: RowLayout {
                Controls.Button { visible: showingSettings; text: qsTr("←"); onClicked: showingSettings = false; Accessible.name: qsTr("Back") }
                Controls.Label { visible: showingSettings; text: qsTr("Settings"); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
                Controls.TabBar { id: mainModeTabs; visible: !showingSettings; currentIndex: ["Sync", "Drive", "Photos", "New"].indexOf(currentMode); onCurrentIndexChanged: if (currentIndex >= 0 && !showingSettings) currentMode = ["Sync", "Drive", "Photos", "New"][currentIndex]; Layout.fillWidth: true
                    Controls.TabButton { text: qsTr("Sync"); Accessible.name: qsTr("Sync tab") }
                    Controls.TabButton { text: qsTr("Files"); Accessible.name: qsTr("Files tab") }
                    Controls.TabButton { text: qsTr("Photos"); Accessible.name: qsTr("Photos tab") }
                    Controls.TabButton { text: qsTr("New +"); Accessible.name: qsTr("New tab") }
                }
            }
        }
    }
    pageStack.initialPage: Kirigami.ScrollablePage {
        title: ""
        StackLayout { id: modeStack; width: parent.width; currentIndex: modeIndex()
        ColumnLayout { Layout.fillWidth: true; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("Sync"); level: 2 }
            RowLayout { Layout.fillWidth: true; Layout.fillHeight: true; Layout.alignment: Qt.AlignTop
                ColumnLayout { Layout.minimumWidth: 180; Layout.maximumWidth: 180; Layout.fillHeight: true; Layout.alignment: Qt.AlignTop
                    Controls.Button { text: qsTr("Dashboard"); checkable: true; checked: syncSectionIndex === 0; onClicked: syncSectionIndex = 0; Layout.fillWidth: true; Accessible.name: qsTr("Sync dashboard") }
                    Controls.Button { text: qsTr("Notifications"); checkable: true; checked: syncSectionIndex === 1; onClicked: syncSectionIndex = 1; Layout.fillWidth: true; Accessible.name: qsTr("Sync notifications") }
                    Controls.Button { text: qsTr("Photos map"); checkable: true; checked: syncSectionIndex === 2; onClicked: syncSectionIndex = 2; Layout.fillWidth: true; Accessible.name: qsTr("Photos map") }
                    Controls.Button { text: qsTr("Files map"); checkable: true; checked: syncSectionIndex === 3; onClicked: syncSectionIndex = 3; Layout.fillWidth: true; Accessible.name: qsTr("Files map") }
                    Kirigami.Separator { Layout.fillWidth: true }
                    Controls.Button { text: qsTr("⚙ Settings"); onClicked: showingSettings = true; Layout.fillWidth: true; Accessible.name: qsTr("Settings") }
                }
                StackLayout { id: syncStack; currentIndex: syncSectionIndex; Layout.fillWidth: true; Layout.fillHeight: true; Layout.alignment: Qt.AlignTop
                    ColumnLayout {
                        RowLayout { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                            Kirigami.Card { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                                header: Controls.Label { text: qsTr("Storage across devices"); font.bold: true; Accessible.name: text }
                                contentItem: ColumnLayout {
                                    Controls.Label { text: qsTr("Shared catalog view · live values are marked Online now; offline values are Last reported."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                                    Repeater { model: storageCandidates(); delegate: RowLayout { Layout.fillWidth: true; Controls.Label { text: modelData.label; Layout.fillWidth: true; Accessible.name: text } Controls.ProgressBar { visible: storagePercent(modelData) >= 0; value: Math.max(0, storagePercent(modelData)) / 100; Layout.preferredWidth: 110; Accessible.name: qsTr("Storage used") } Controls.Label { text: storagePercent(modelData) >= 0 ? qsTr("%1% full").arg(storagePercent(modelData)) : (modelData.present ? qsTr("Online now") : qsTr("Last reported")); Accessible.name: text } } }
                                    Controls.Label { visible: storageCandidates().length === 0; text: qsTr("No external storage is currently known."); Accessible.name: text }
                                }
                            }
                            Kirigami.Card { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                                header: Controls.Label { text: qsTr("Notifications"); font.bold: true; Accessible.name: text }
                                contentItem: ColumnLayout {
                                    Repeater { model: notificationItems().slice(0, 3); delegate: RowLayout { Layout.fillWidth: true; Controls.Label { text: qsTr("%1\n%2").arg(modelData.title).arg(modelData.detail); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text } Controls.Button { text: modelData.action; onClicked: openDashboardAction(modelData.target); Accessible.name: modelData.action } } }
                                    Controls.Label { visible: notificationItems().length === 0; text: qsTr("No active notifications."); Accessible.name: text }
                                }
                            }
                        }
                        RowLayout { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                            Kirigami.Card { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                                header: Controls.Label { text: qsTr("Remaining storage per device"); font.bold: true; Accessible.name: text }
                                contentItem: ColumnLayout {
                                    Controls.Label { text: qsTr("Computer · %1").arg(setupModel.localDeviceName); Layout.fillWidth: true; Accessible.name: text }
                                    Repeater { model: storageCandidates(); delegate: Controls.Label { text: qsTr("%1 · %2 free · %3").arg(modelData.label).arg(bytesText(modelData.bytesFree)).arg(modelData.present ? qsTr("Online now") : qsTr("Last reported")); Layout.fillWidth: true; Accessible.name: text } }
                                    Repeater { model: setupModel.connectedDevices; delegate: Controls.Label { text: qsTr("%1 · phone status: %2").arg(modelData.label).arg(modelData.status || qsTr("Last reported")); Layout.fillWidth: true; Accessible.name: text } }
                                }
                            }
                            Kirigami.Card { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                                header: Controls.Label { text: qsTr("Devices · last detected"); font.bold: true; Accessible.name: text }
                                contentItem: ColumnLayout {
                                    Repeater { model: setupModel.deviceList; delegate: Controls.Label { text: qsTr("%1 · %2").arg(modelData.label).arg(modelData.present ? qsTr("Online now") : qsTr("Last known: %1").arg(modelData.lastSeen || qsTr("unknown"))); Layout.fillWidth: true; Accessible.name: text } }
                                    Controls.Label { visible: setupModel.deviceList.length === 0; text: qsTr("No remote device has reported yet."); Accessible.name: text }
                                }
                            }
                        }
                        Kirigami.Card { Layout.fillWidth: true; visible: setupModel.routes.length === 0
                            header: Controls.Label { text: qsTr("Setup required"); font.bold: true; Accessible.name: text }
                            contentItem: RowLayout { Controls.Label { text: qsTr("Connect this computer to a backup storage device before the first transfer."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text } Controls.Button { text: qsTr("Open Setup…"); onClicked: openRouteSetup(0, "", true); Accessible.name: qsTr("Open Setup") } }
                        }
                        Kirigami.Card { Layout.fillWidth: true; visible: copyEngine.logEntries.length > 0
                            header: Controls.Label { text: qsTr("Live log"); Accessible.name: text }
                            contentItem: ColumnLayout { Repeater { model: copyEngine.logEntries.slice(Math.max(0, copyEngine.logEntries.length - 8)); delegate: Controls.Label { text: modelData; elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text } } }
                        }
                    }
                    ColumnLayout {
                        Repeater { model: notificationItems(); delegate: Kirigami.Card { Layout.fillWidth: true
                            header: Controls.Label { text: modelData.title; font.bold: true; Accessible.name: text }
                            contentItem: RowLayout { Controls.Label { text: modelData.detail; wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text } Controls.Button { text: modelData.action; onClicked: openDashboardAction(modelData.target); Accessible.name: text } }
                        } }
                        Controls.Label { visible: notificationItems().length === 0; text: qsTr("No notifications from the shared catalog."); Accessible.name: text }
                    }
                    ColumnLayout { Kirigami.Heading { text: qsTr("Photos connection map"); level: 3 } Loader { Layout.fillWidth: true; sourceComponent: connectionMap; onLoaded: item.mapContentType = "Photos" } }
                    ColumnLayout { Kirigami.Heading { text: qsTr("Files connection map"); level: 3 } Loader { Layout.fillWidth: true; sourceComponent: connectionMap; onLoaded: item.mapContentType = "Drive" } }
                }
            }
        }
        ColumnLayout { Layout.fillWidth: true; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("Drive"); level: 2 }
            Controls.Label { text: qsTr("Ordinary files in the configured Drive root. The verified route actions remain available from Sync."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Kirigami.Card { Layout.fillWidth: true
                header: Controls.Label { text: qsTr("Drive files"); Accessible.name: text }
                contentItem: ColumnLayout {
                    Repeater { model: setupModel.routes.filter(function(route) { return route.contentType === "Drive" }); delegate: routeMapCard }
                    Controls.Label { visible: setupModel.routes.filter(function(route) { return route.contentType === "Drive" }).length === 0; text: qsTr("No Drive route saved yet."); Accessible.name: text }
                }
            }
        }
        ColumnLayout { Layout.fillWidth: true; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("Photos"); level: 2 }
            Controls.Label { text: qsTr("Photos and videos in the configured Photos root. The library stays ordinary files and remains editable by normal applications."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Kirigami.Card { Layout.fillWidth: true
                header: Controls.Label { text: qsTr("Photos routes"); Accessible.name: text }
                contentItem: ColumnLayout {
                    Repeater { model: setupModel.routes.filter(function(route) { return route.contentType === "Photos" }); delegate: routeMapCard }
                    Controls.Label { visible: setupModel.routes.filter(function(route) { return route.contentType === "Photos" }).length === 0; text: qsTr("No Photos route saved yet."); Accessible.name: text }
                }
            }
        }
        ColumnLayout { Layout.fillWidth: true; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("New"); level: 2 }
            Controls.Label { text: qsTr("Start a focused task. These actions keep the same keyboard-first workflow and do not silently start a transfer."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            RowLayout { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                Kirigami.Card { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                    header: Controls.Label { text: qsTr("Transfer"); font.bold: true; Accessible.name: text }
                    contentItem: ColumnLayout {
                        Controls.Label { text: qsTr("Preview and run a saved Files or Photos route."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                        Controls.Button { text: qsTr("Open Sync"); onClicked: currentMode = "Sync"; Accessible.name: qsTr("Open Sync") }
                    }
                }
                Kirigami.Card { Layout.fillWidth: true; Layout.alignment: Qt.AlignTop
                    header: Controls.Label { text: qsTr("Configure"); font.bold: true; Accessible.name: text }
                    contentItem: ColumnLayout {
                        Controls.Label { text: qsTr("Add storage locations, review device maps, and configure connections."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                        Controls.Button { text: qsTr("Open Settings"); onClicked: showingSettings = true; Accessible.name: qsTr("Open Settings") }
                    }
                }
            }
            Controls.Label { text: qsTr("New folder and document scanning are planned after the transfer workflow is validated on real devices."); wrapMode: Text.WordWrap; color: Kirigami.Theme.disabledTextColor; Layout.fillWidth: true; Accessible.name: text }
        }
        ColumnLayout { Layout.fillWidth: true; spacing: 0
            Controls.SplitView { Layout.fillWidth: true; Layout.preferredHeight: 620; orientation: Qt.Horizontal
                handle: Rectangle { implicitWidth: 1; color: Kirigami.Theme.disabledTextColor; opacity: 0.3 }
                Rectangle { Controls.SplitView.minimumWidth: 250; Controls.SplitView.preferredWidth: 250; Controls.SplitView.maximumWidth: 250; color: Kirigami.Theme.backgroundColor
                    ColumnLayout { anchors.fill: parent; anchors.margins: Kirigami.Units.smallSpacing; spacing: Kirigami.Units.smallSpacing
                        Controls.TextField { id: settingsSearch; placeholderText: qsTr("Search settings…"); Layout.fillWidth: true; Accessible.name: qsTr("Search settings") }
                        Controls.Label { visible: settingsMatches(qsTr("Storage & locations")); text: qsTr("STORAGE"); font.bold: true; color: Kirigami.Theme.disabledTextColor; topPadding: Kirigami.Units.smallSpacing; Accessible.name: text }
                        Controls.ItemDelegate { visible: settingsMatches(qsTr("Storage & locations")); text: qsTr("Storage & locations"); icon.name: "drive-harddisk"; highlighted: settingsCategoryIndex === 0; onClicked: settingsCategoryIndex = 0; Layout.fillWidth: true; Accessible.name: qsTr("Storage and locations settings") }
                        Kirigami.Separator { visible: settingsSearch.text.length === 0; Layout.fillWidth: true }
                        Controls.Label { visible: settingsMatches(qsTr("Sync & device maps")); text: qsTr("SYNCHRONIZATION"); font.bold: true; color: Kirigami.Theme.disabledTextColor; topPadding: Kirigami.Units.smallSpacing; Accessible.name: text }
                        Controls.ItemDelegate { visible: settingsMatches(qsTr("Sync & device maps")); text: qsTr("Sync & device maps"); icon.name: "folder-sync"; highlighted: settingsCategoryIndex === 1; onClicked: settingsCategoryIndex = 1; Layout.fillWidth: true; Accessible.name: qsTr("Sync and device maps") }
                        Kirigami.Separator { visible: settingsSearch.text.length === 0; Layout.fillWidth: true }
                        Controls.Label { visible: settingsMatches(qsTr("Wired & wireless")); text: qsTr("CONNECTIONS"); font.bold: true; color: Kirigami.Theme.disabledTextColor; topPadding: Kirigami.Units.smallSpacing; Accessible.name: text }
                        Controls.ItemDelegate { visible: settingsMatches(qsTr("Wired & wireless")); text: qsTr("Wired & wireless"); icon.name: "network-wired"; highlighted: settingsCategoryIndex === 2; onClicked: settingsCategoryIndex = 2; Layout.fillWidth: true; Accessible.name: qsTr("Wired and wireless settings") }
                        Item { Layout.fillHeight: true }
                        Controls.Label { text: qsTr("Changes are applied when you use the action in each page."); wrapMode: Text.WordWrap; color: Kirigami.Theme.disabledTextColor; Layout.fillWidth: true; Accessible.name: text }
                    }
                }
                Item { Controls.SplitView.fillWidth: true
                    StackLayout { currentIndex: settingsCategoryIndex; anchors.top: parent.top; anchors.horizontalCenter: parent.horizontalCenter; width: Math.min(parent.width - Kirigami.Units.largeSpacing * 4, 920)
                    ColumnLayout {
                        Kirigami.Heading { text: qsTr("Storage & locations"); level: 3 }
                        Kirigami.Separator { Layout.fillWidth: true }
                        Controls.Label { text: qsTr("The source library stays under Home. Each backup route points to an exact writable disk or server."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                        Repeater { model: storageCandidates(); delegate: Kirigami.Card { Layout.fillWidth: true; contentItem: RowLayout { Controls.Label { text: modelData.present ? "●" : "○"; color: modelData.present ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.disabledTextColor; Accessible.name: modelData.present ? qsTr("Online") : qsTr("Offline") } ColumnLayout { Layout.fillWidth: true; Controls.Label { text: modelData.label; font.bold: true; Accessible.name: text } Controls.Label { text: qsTr("%1 free · %2").arg(bytesText(modelData.bytesFree)).arg(modelData.root); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text } } Controls.Button { text: qsTr("👁"); flat: true; onClicked: setupModel.acknowledgeDevice(modelData.id, true); Accessible.name: qsTr("Hide %1").arg(modelData.label) } } } }
                        Controls.Label { visible: storageCandidates().length === 0; text: qsTr("No external storage is currently known."); Accessible.name: text }
                        RowLayout { Controls.Button { text: qsTr("Add Files route…"); onClicked: openRouteSetup(0, "", false); Accessible.name: qsTr("Add Files route") } Controls.Button { text: qsTr("Add Photos route…"); onClicked: openRouteSetup(1, "", false); Accessible.name: qsTr("Add Photos route") } }
                        Repeater { model: setupModel.routes; delegate: routeMapCard }
                    }
                    ColumnLayout {
                        Kirigami.Heading { text: qsTr("Sync & device maps"); level: 3 }
                        Kirigami.Separator { Layout.fillWidth: true }
                        Controls.TabBar { currentIndex: settingsContentIndex; onCurrentIndexChanged: settingsContentIndex = currentIndex; Layout.fillWidth: true; Controls.TabButton { text: qsTr("Files"); Accessible.name: qsTr("Files map") } Controls.TabButton { text: qsTr("Photos"); Accessible.name: qsTr("Photos map") } }
                        Loader { Layout.fillWidth: true; sourceComponent: connectionMap; onLoaded: item.mapContentType = Qt.binding(function() { return settingsContentIndex === 0 ? "Drive" : "Photos" }) }
                    }
                    ColumnLayout {
                        Kirigami.Heading { text: qsTr("Wired & wireless"); level: 3 }
                        Kirigami.Separator { Layout.fillWidth: true }
                        Controls.TabBar { currentIndex: settingsConnectionIndex; onCurrentIndexChanged: settingsConnectionIndex = currentIndex; Layout.fillWidth: true; Controls.TabButton { text: qsTr("Devices"); Accessible.name: qsTr("Wired devices") } Controls.TabButton { text: qsTr("Wireless receiver"); Accessible.name: qsTr("Wireless receiver") } }
                        StackLayout { currentIndex: settingsConnectionIndex; Layout.fillWidth: true
                            ColumnLayout {
                                Controls.Label { text: qsTr("This computer — %1").arg(setupModel.localDeviceName); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
                                Repeater { model: setupModel.deviceList; delegate: Kirigami.Card { Layout.fillWidth: true; contentItem: RowLayout { Controls.Label { text: modelData.present ? "●" : "○"; color: modelData.present ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.disabledTextColor; Accessible.name: modelData.present ? qsTr("Online") : qsTr("Offline") } ColumnLayout { Layout.fillWidth: true; Controls.Label { text: modelData.label; font.bold: true; Accessible.name: text } Controls.Label { text: qsTr("%1 · %2").arg(modelData.status).arg((modelData.transports || []).join(" + ") || qsTr("Last known")); Accessible.name: text } } Controls.Button { text: qsTr("👁"); flat: true; onClicked: setupModel.acknowledgeDevice(modelData.id, true); Accessible.name: qsTr("Hide %1").arg(modelData.label) } } } }
                                Controls.Button { text: qsTr("Refresh devices"); onClicked: refreshAll(); Accessible.name: qsTr("Refresh devices") }
                                Kirigami.Heading { text: qsTr("Hidden devices"); level: 4 }
                                Repeater { model: setupModel.hiddenDevices; delegate: RowLayout { Layout.fillWidth: true; Controls.Label { text: qsTr("%1 · %2").arg(modelData.label).arg(modelData.stableIdentity); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text } Controls.Button { text: qsTr("👁"); flat: true; onClicked: setupModel.showDevice(modelData.id); Accessible.name: qsTr("Show %1 again").arg(modelData.label) } } }
                                Controls.Label { visible: setupModel.hiddenDevices.length === 0; text: qsTr("No hidden devices."); Accessible.name: text }
                            }
                            Kirigami.Card { Layout.fillWidth: true; contentItem: ColumnLayout {
                            Controls.Label { text: qsTr("The receiver uses the saved secure profile. The port is automatic and is not a user setting."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                            Controls.Label { text: qsTr("Status: %1").arg(wirelessReceiver.status); Layout.fillWidth: true; Accessible.name: text }
                            Kirigami.FormLayout { Layout.fillWidth: true
                                Controls.TextField { id: receiverHost; Kirigami.FormData.label: qsTr("Host:"); placeholderText: qsTr("Laptop LAN address or hostname"); Layout.fillWidth: true; Accessible.name: qsTr("Laptop LAN address") }
                                RowLayout { Kirigami.FormData.label: qsTr("Destination:"); Controls.TextField { id: receiverDestination; placeholderText: qsTr("Local Drive destination folder"); Layout.fillWidth: true; Accessible.name: qsTr("Wireless destination") } Controls.Button { text: qsTr("Choose…"); onClicked: receiverDestinationDialog.open(); Accessible.name: qsTr("Choose wireless destination") } }
                                RowLayout { Kirigami.FormData.label: qsTr("Server certificate:"); Controls.TextField { id: receiverCertificate; placeholderText: qsTr("PEM file"); Layout.fillWidth: true; Accessible.name: qsTr("Server certificate") } Controls.Button { text: qsTr("Choose…"); onClicked: receiverCertificateDialog.open(); Accessible.name: qsTr("Choose server certificate") } }
                                RowLayout { Kirigami.FormData.label: qsTr("Private key:"); Controls.TextField { id: receiverPrivateKey; placeholderText: qsTr("PEM file"); Layout.fillWidth: true; Accessible.name: qsTr("Server private key") } Controls.Button { text: qsTr("Choose…"); onClicked: receiverPrivateKeyDialog.open(); Accessible.name: qsTr("Choose server key") } }
                                RowLayout { Kirigami.FormData.label: qsTr("Android certificate:"); Controls.TextField { id: receiverClientCa; placeholderText: qsTr("PEM file"); Layout.fillWidth: true; Accessible.name: qsTr("Android certificate") } Controls.Button { text: qsTr("Choose…"); onClicked: receiverClientCaDialog.open(); Accessible.name: qsTr("Choose Android certificate") } }
                                Controls.TextField { id: receiverFingerprint; Kirigami.FormData.label: qsTr("Pinned fingerprint:"); placeholderText: qsTr("Android SHA-256 fingerprint"); Layout.fillWidth: true; Accessible.name: qsTr("Pinned Android fingerprint") }
                            }
                            Controls.TextField { id: receiverPort; visible: false; text: "43171"; Layout.preferredWidth: 1; Layout.preferredHeight: 1 }
                            RowLayout { Controls.Button { text: qsTr("Start receiver"); enabled: !wirelessReceiver.listening; onClicked: wirelessReceiver.start(receiverDestination.text, receiverCertificate.text, receiverPrivateKey.text, receiverClientCa.text, receiverFingerprint.text, Number(receiverPort.text)); Accessible.name: qsTr("Start receiver") } Controls.Button { text: qsTr("Stop receiver"); enabled: wirelessReceiver.listening; onClicked: wirelessReceiver.stop(); Accessible.name: qsTr("Stop receiver") } }
                            RowLayout { Controls.Button { text: qsTr("Export Android profile…"); enabled: receiverHost.text.trim().length > 0 && receiverCertificate.text.trim().length > 0; onClicked: receiverProfileExportDialog.open(); Accessible.name: qsTr("Export Android profile") } Controls.Button { text: qsTr("Accept Android certificate…"); onClicked: receiverProfileImportDialog.open(); Accessible.name: qsTr("Accept Android certificate") } }
                            Controls.Label { text: qsTr("Private keys never leave this computer."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                            Repeater { model: wirelessReceiver.logEntries.slice(Math.max(0, wirelessReceiver.logEntries.length - 12)); delegate: Controls.Label { text: modelData; elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text } }
                            } }
                        }
                    }
                }
                }
            }
        }
        }
    }
    Controls.Dialog { id: setupDialog; modal: true; width: 760; closePolicy: Controls.Popup.CloseOnEscape; standardButtons: Controls.Dialog.NoButton
        header: RowLayout {
            Controls.Label { text: qsTr("Setup · step %1 of 3").arg(setupStep); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { text: qsTr("✕"); flat: true; onClicked: { configuringRoute = false; setupDialog.close() } Accessible.name: qsTr("Close Setup") }
        }
        contentItem: ColumnLayout {
            Controls.Label { visible: setupStep === 1; text: qsTr("Build the first connection on the device map. Local Drive keeps ordinary files and records verified transfer history."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            ColumnLayout { visible: setupStep === 2; Layout.fillWidth: true
                Controls.Label { text: qsTr("1. Choose this computer's library under %1").arg(homeRoot()); font.bold: true; Accessible.name: text }
                RowLayout { Layout.fillWidth: true; Controls.TextField { id: source; readOnly: true; placeholderText: qsTr("Choose a folder in your home"); Layout.fillWidth: true; Accessible.name: qsTr("Computer library folder") } Controls.Button { text: qsTr("Choose…"); onClicked: sourceDialog.open(); Accessible.name: qsTr("Choose computer library folder") } }
            }
            ColumnLayout { visible: setupStep === 3; Layout.fillWidth: true
                Controls.Label { text: qsTr("2. Choose the storage device and its backup folder"); font.bold: true; Accessible.name: text }
                Controls.Label { text: qsTr("This becomes the second node on the map. A phone is a source device, not this backup destination."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
                Controls.ComboBox { id: storage; model: storageCandidates(); textRole: "label"; valueRole: "id"; currentIndex: 0; Layout.fillWidth: true; Accessible.name: qsTr("Backup destination") }
                RowLayout { Layout.fillWidth: true; Controls.TextField { id: destination; readOnly: true; placeholderText: qsTr("Choose an existing writable folder"); Layout.fillWidth: true; Accessible.name: qsTr("Backup folder") } Controls.Button { text: qsTr("Choose…"); enabled: storage.currentIndex >= 0; onClicked: destinationDialog.open(); Accessible.name: qsTr("Choose backup folder") } }
                Controls.Label { text: qsTr("This only saves the device locations. Configure the Files and Photos arrows separately on the visual map."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            }
            RowLayout { Layout.fillWidth: true; Layout.alignment: Qt.AlignRight
                Controls.Button { visible: setupStep > 1; text: qsTr("Back"); onClicked: setupStep -= 1; Accessible.name: qsTr("Back one setup step") }
                Controls.Button { visible: setupStep < 3; text: qsTr("Next"); enabled: setupStep !== 2 || (source.text.length > 0 && isUnderHome(source.text)); onClicked: setupStep += 1; Accessible.name: qsTr("Next setup step") }
                Controls.Button { id: saveRouteButton; visible: setupStep === 3; text: pendingSetupBoth ? qsTr("Create map") : qsTr("Save locations"); enabled: setupModel.ready && storage.currentIndex >= 0 && source.text.length > 0 && destination.text.length > 0 && isUnderHome(source.text); onClicked: saveCurrentRoute(); Accessible.name: text }
            }
        }
    }
    Controls.Dialog { id: relationshipDialog; modal: true; width: 520; closePolicy: Controls.Popup.CloseOnEscape; standardButtons: Controls.Dialog.NoButton
        header: RowLayout { Controls.Label { text: qsTr("Device relationship"); font.bold: true; Layout.fillWidth: true; Accessible.name: text } Controls.Button { text: qsTr("✕"); flat: true; onClicked: relationshipDialog.close(); Accessible.name: qsTr("Close relationship") } }
        contentItem: ColumnLayout {
            Controls.Label { text: qsTr("%1  ↔  %2").arg(firstMapNode.label || qsTr("First device")).arg(secondMapNode.label || qsTr("Second device")); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Choose the behavior of this connection for %1.").arg(selectedMapContentType === "Drive" ? qsTr("Files") : qsTr("Photos")); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.CheckBox { id: relationshipSend; text: qsTr("Send"); Accessible.name: qsTr("Send on this connection") }
            Controls.CheckBox { id: relationshipReceive; text: qsTr("Receive"); Accessible.name: qsTr("Receive on this connection") }
            Controls.CheckBox { id: relationshipKeep; text: qsTr("Keep source files"); Accessible.name: qsTr("Keep source files after verified transfer") }
            Controls.Label { text: relationshipKeep.checked ? qsTr("Keep checked: verified copy; source files remain.") : qsTr("Keep unchecked: verified move; source cleanup still requires explicit Trash confirmation."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { id: relationshipStatus; text: ""; visible: text.length > 0; color: Kirigami.Theme.negativeTextColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            RowLayout { Layout.alignment: Qt.AlignRight; Controls.Button { text: qsTr("Cancel"); onClicked: relationshipDialog.close(); Accessible.name: qsTr("Cancel relationship") } Controls.Button { text: qsTr("Apply"); onClicked: applyRelationship(); Accessible.name: qsTr("Apply device relationship") } }
        }
        onClosed: { firstMapNode = ({}); secondMapNode = ({}) }
    }
    Controls.Dialog { id: moreRelationshipsDialog; modal: true; width: 520; standardButtons: Controls.Dialog.NoButton
        contentItem: ColumnLayout {
            Controls.Label { text: qsTr("Add another Files relationship?"); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Only connections supported by the current transfer engine are offered."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            RowLayout { Layout.alignment: Qt.AlignRight
                Controls.Button { text: qsTr("Yes, add another"); onClicked: { moreRelationshipsDialog.close(); openRouteSetup(0, "", false, pendingSetupKeepPolicy) }; Accessible.name: text }
                Controls.Button { text: qsTr("No, finish Files"); onClicked: { moreRelationshipsDialog.close(); pendingMountedStorageFlow = false; clonePhotosMapDialog.open() }; Accessible.name: text }
            }
        }
    }
    Controls.Dialog { id: storageScopeDialog; modal: true; width: 560; standardButtons: Controls.Dialog.NoButton
        contentItem: ColumnLayout {
            Controls.Label { text: qsTr("Connect %1 with this laptop").arg(onboardingDevice.label || qsTr("storage")); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Only relationships the app can transfer safely today are shown. Choose which map will use this storage."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            RowLayout { Layout.alignment: Qt.AlignRight
                Controls.Button { text: qsTr("Drive"); onClicked: { storageScopeDialog.close(); pendingMountedStorageFlow = false; openRouteSetup(0, pendingMountedStorageId, false) }; Accessible.name: text }
                Controls.Button { text: qsTr("Photos"); onClicked: { storageScopeDialog.close(); pendingMountedStorageFlow = false; openRouteSetup(1, pendingMountedStorageId, false) }; Accessible.name: text }
                Controls.Button { text: qsTr("Drive and Photos"); onClicked: { storageScopeDialog.close(); pendingMountedStorageFlow = true; openRouteSetup(0, pendingMountedStorageId, false) }; Accessible.name: text }
            }
        }
    }
    Controls.Dialog { id: clonePhotosMapDialog; modal: true; width: 560; standardButtons: Controls.Dialog.NoButton
        contentItem: ColumnLayout {
            Controls.Label { text: qsTr("Should files and photos use the same synchronization map?"); font.bold: true; wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Yes makes a one-time copy of devices, directions, and Keep policies. Later changes remain independent."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            RowLayout { Layout.alignment: Qt.AlignRight
                Controls.Button { text: qsTr("No, configure Photos"); onClicked: { clonePhotosMapDialog.close(); openRouteSetup(1, pendingMountedStorageId, false, pendingSetupKeepPolicy) }; Accessible.name: text }
                Controls.Button { text: qsTr("Yes, copy the map"); onClicked: { if (setupModel.cloneDriveMapToPhotos()) { clonePhotosMapDialog.close(); syncSectionIndex = 2 } }; Accessible.name: text }
            }
        }
    }
    Connections { target: copyEngine; function onPreviewChanged() { selectedPreview = copyEngine.previewData; selectedCleanup = copyEngine.cleanupPreview(); selectedHistory = copyEngine.recentHistory(); transferProgress = 0; transferPath = "" } function onProgressChanged(done, total, path) { transferProgress = total > 0 ? done / total : 0; transferPath = path } function onFinished(success, message) { resumeTimer.stop(); pauseRemainingMilliseconds = 0; setupModel.refreshRoutes(); selectedCleanup = copyEngine.cleanupPreview(); selectedHistory = copyEngine.recentHistory(); transferProgress = 0; transferPath = ""; if (pendingPhonePhotos) { pendingPhonePhotos = false; if (success) Qt.callLater(function() { startPhoneImport("Photos", "DCIM") }); else phoneActionStatus = message } } }
    Connections { target: setupModel; function onChanged() { showOnboardingIfNeeded() } }
    FolderDialog { id: sourceDialog; title: qsTr("Choose a computer folder inside Home"); currentFolder: "file://" + homeRoot(); onAccepted: { const path = setupModel.pathFromUrl(selectedFolder); if (isUnderHome(path)) source.text = path } }
    FolderDialog { id: destinationDialog; title: qsTr("Choose an existing writable backup folder"); currentFolder: storage.currentIndex >= 0 && storageCandidates().length > storage.currentIndex ? "file://" + storageCandidates()[storage.currentIndex].root : "file://" + homeRoot(); onAccepted: destination.text = setupModel.pathFromUrl(selectedFolder) }
    FolderDialog { id: receiverDestinationDialog; title: qsTr("Choose wireless destination root"); onAccepted: receiverDestination.text = setupModel.pathFromUrl(selectedFolder) }
    FileDialog { id: receiverCertificateDialog; title: qsTr("Choose server certificate"); fileMode: FileDialog.OpenFile; onAccepted: receiverCertificate.text = setupModel.pathFromUrl(selectedFile) }
    FileDialog { id: receiverPrivateKeyDialog; title: qsTr("Choose server private key"); fileMode: FileDialog.OpenFile; onAccepted: receiverPrivateKey.text = setupModel.pathFromUrl(selectedFile) }
    FileDialog { id: receiverClientCaDialog; title: qsTr("Choose Android client certificate"); fileMode: FileDialog.OpenFile; onAccepted: receiverClientCa.text = setupModel.pathFromUrl(selectedFile) }
    FileDialog { id: receiverProfileExportDialog; title: qsTr("Save Android pairing profile"); fileMode: FileDialog.SaveFile; onAccepted: wirelessReceiver.exportProfile(setupModel.pathFromUrl(selectedFile), receiverHost.text, Number(receiverPort.text), receiverCertificate.text) }
    FileDialog { id: receiverProfileImportDialog; title: qsTr("Choose Android pairing certificate"); fileMode: FileDialog.OpenFile; onAccepted: { pendingPairingProfilePath = setupModel.pathFromUrl(selectedFile); receiverClientCaSaveDialog.open() } }
    FileDialog { id: receiverClientCaSaveDialog; title: qsTr("Save Android client certificate"); fileMode: FileDialog.SaveFile; onAccepted: { const output = setupModel.pathFromUrl(selectedFile); const fingerprint = wirelessReceiver.acceptPairingProfile(pendingPairingProfilePath, output); if (fingerprint.length > 0) { receiverClientCa.text = output; receiverFingerprint.text = fingerprint } pendingPairingProfilePath = "" } }
    FileDialog { id: manifestDialog; title: qsTr("Export manifest"); fileMode: FileDialog.SaveFile; nameFilters: [qsTr("JSON manifest (*.json)"), qsTr("CSV manifest (*.csv)")]; onAccepted: { const format = selectedFile.toString().toLowerCase().endsWith(".csv") ? "csv" : "json"; manifestStatus = copyEngine.exportManifest(selectedFile, format) ? qsTr("Manifest exported") : qsTr("Could not export manifest"); } }
    Controls.Dialog { id: pauseDialog; title: qsTr("Pause transfer"); modal: true; width: 560; standardButtons: Controls.Dialog.NoButton
        contentItem: ColumnLayout {
            Controls.Label { text: qsTr("Choose a value from 1 to 99 and a time unit. The application resumes the transfer only while it stays open; closing the application leaves no background service."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            RowLayout {
                Controls.Label { text: qsTr("Duration"); Accessible.name: text }
                Controls.Tumbler { id: pauseAmount; model: 99; currentIndex: 2; visibleItemCount: 5; Layout.preferredWidth: 84; Layout.preferredHeight: 150; Accessible.name: qsTr("Pause duration from 1 to 99")
                    delegate: Controls.Label { text: modelData + 1; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; width: pauseAmount.width; height: pauseAmount.height / pauseAmount.visibleItemCount; Accessible.name: text }
                }
                Controls.Tumbler { id: pauseUnit; model: [qsTr("minutes"), qsTr("hours"), qsTr("days")]; currentIndex: 1; visibleItemCount: 3; Layout.preferredWidth: 120; Layout.preferredHeight: 150; Accessible.name: qsTr("Pause time unit")
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
            Controls.Button { text: qsTr("✕"); flat: true; Accessible.name: qsTr("Close"); onClicked: deferOnboarding() }
        }
        contentItem: ColumnLayout {
            Controls.Label { text: onboardingDevice.label || qsTr("Unknown device"); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.category === "storage"; text: qsTr("Stable identity: %1").arg(onboardingDevice.stableIdentity || qsTr("not available")); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.category === "storage"; text: qsTr("Filesystem: %1 · selected root: %2").arg(onboardingDevice.filesystemType || qsTr("unknown")).arg(onboardingDevice.root || qsTr("not available")); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.category === "storage"; text: qsTr("Choose its role and the Drive/Photos roots in the connection map. Local Drive will never format this storage automatically."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.category === "storage"; text: qsTr("Do you want this storage to participate in Local Drive?"); font.bold: true; wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.kind === "Phone"; text: qsTr("Phone setup: unlock Android and select USB mode ‘File transfer / MTP’. Local Drive uses the fixed phone roots Drive/ for files and DCIM/ for photos and videos."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.kind === "Phone"; text: qsTr("Available actions after setup: Drive → Drive and DCIM → Photos. Detection alone never starts a transfer. Wireless pairing uses the Android profile exchange and the Wireless receiver panel in Settings."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { visible: onboardingDevice.wirelessCandidate === true; text: qsTr("Wireless setup — 1) On Android, import the Linux receiver profile and share the Android public certificate back. 2) In Settings, choose the destination and certificate files, then pin the Android SHA-256 fingerprint. 3) Start the receiver. 4) Keep both devices on the same LAN and let the phone connect. Discovery only finds the phone; it never grants file access."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { visible: onboardingDevice.wirelessCandidate === true; text: qsTr("Open Wireless receiver settings"); Layout.alignment: Qt.AlignLeft; onClicked: openWirelessSettingsFromOnboarding(); Accessible.name: qsTr("Open Wireless receiver settings") }
            Controls.Label { visible: onboardingDevice.wirelessCandidate === true; text: qsTr("If this is the same phone as a USB device, select it below and pair explicitly so the list keeps one device with both transports. The Alpha setup uses JSON profile exchange; automatic QR certificate onboarding is not enabled yet."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.ComboBox { id: wirelessMtpTarget; visible: onboardingDevice.wirelessCandidate === true && setupModel.mtpDevices.length > 1; model: setupModel.mtpDevices; textRole: "label"; valueRole: "id"; Layout.fillWidth: true; Accessible.name: qsTr("Choose the USB phone matching this wireless phone") }
            Controls.Button { visible: onboardingDevice.wirelessCandidate === true && setupModel.mtpDevices.length > 0; text: qsTr("Pair with the selected USB phone"); Layout.alignment: Qt.AlignLeft; onClicked: { const targetId = setupModel.mtpDevices.length === 1 ? setupModel.mtpDevices[0].id : wirelessMtpTarget.currentValue; if (targetId && setupModel.pairWirelessDevice(onboardingDevice.id, targetId)) finishOnboarding(false) } Accessible.name: qsTr("Pair wireless candidate with the selected USB phone") }
            Controls.Label { visible: onboardingDevice.category !== "storage" && onboardingDevice.kind !== "Phone"; text: qsTr("Only detected capabilities are shown. Choose the matching pairing or storage step; Local Drive will not guess a server protocol."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.CheckBox { id: hideOnboarding; visible: onboardingDevice.category !== "storage"; text: qsTr("Do not show this device again"); Accessible.name: qsTr("Do not show this device again") }
            Controls.Label { text: qsTr("Not now postpones the choice. Hidden devices remain recoverable in Settings."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            RowLayout { Layout.alignment: Qt.AlignRight
                Controls.Button { text: qsTr("Not now"); onClicked: deferOnboarding(); Accessible.name: text }
                Controls.Button { visible: onboardingDevice.category === "storage"; text: qsTr("No, hide it"); onClicked: finishOnboarding(true); Accessible.name: text }
                Controls.Button { visible: onboardingDevice.category === "storage"; text: qsTr("Yes, add to map"); onClicked: { pendingMountedStorageId = onboardingDevice.id; finishOnboarding(false); Qt.callLater(function() { storageScopeDialog.open() }) } Accessible.name: text }
                Controls.Button { visible: onboardingDevice.category !== "storage"; text: qsTr("Done"); onClicked: finishOnboarding(hideOnboarding.checked); Accessible.name: text }
            }
        }
        onRejected: deferOnboarding()
        onClosed: if (onboardingDeviceId.length > 0) onboardingDeviceId = ""
    }
    Controls.Dialog { id: phoneActionDialog; modal: true; width: 620; closePolicy: Controls.Popup.CloseOnEscape
        header: RowLayout {
            Controls.Label { text: qsTr("Phone transfer"); font.bold: true; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { text: qsTr("✕"); flat: true; Accessible.name: qsTr("Close"); onClicked: phoneActionDialog.close() }
        }
        contentItem: ColumnLayout {
            Controls.Label { text: qsTr("%1 · %2").arg(phoneActionDevice.label || qsTr("Phone")).arg(phoneActionDevice.stableIdentity || ""); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Detected storage root: %1").arg(phoneActionDevice.phoneRoot || qsTr("discovering…")); elide: Text.ElideMiddle; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Start transfers everything from Drive/ to Files and from DCIM/ to Photos. Local Drive verifies every copy and never deletes files from the phone."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { text: qsTr("Start transfer"); enabled: !copyEngine.running; onClicked: startPhoneTransferAll(); Accessible.name: qsTr("Start complete phone transfer") }
            Controls.Label { visible: phoneActionStatus.length > 0; text: phoneActionStatus; color: Kirigami.Theme.negativeTextColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Button { text: qsTr("Cancel"); Layout.alignment: Qt.AlignRight; onClicked: phoneActionDialog.close(); Accessible.name: text }
        }
    }
    Component.onCompleted: {
        receiverDestination.text = wirelessReceiver.savedDestination
        receiverHost.text = wirelessReceiver.savedHost
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
