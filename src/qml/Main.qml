import QtQuick
import QtQuick.Controls as Controls
import QtQuick.Layouts
import QtQuick.Dialogs
import org.kde.kirigami as Kirigami

Kirigami.ApplicationWindow {
    visible: true
    width: 900; height: 700
    title: qsTr("Local Drive — Setup")
    property var selectedPreview: ({})
    property string previewRouteId: ""
    function routeDescription() {
        return behavior.currentIndex === 0 ? qsTr("Copy and verify; keep source") : qsTr("Move policy saved; execution unavailable until verified cleanup is implemented")
    }
    function selectedStorageLabel() { return storage.currentIndex >= 0 ? storage.currentText : qsTr("No external storage detected") }
    pageStack.initialPage: Kirigami.ScrollablePage {
        title: qsTr("Set up a file route")
        ColumnLayout { width: parent.width; spacing: Kirigami.Units.largeSpacing
            Kirigami.Heading { text: qsTr("Computer and storage"); level: 2 }
            Kirigami.Card { Layout.fillWidth: true
                header: Controls.Label { text: qsTr("Computer — %1").arg(setupModel.localDeviceName); Accessible.name: text }
                contentItem: Controls.Label { text: qsTr("Present · catalog %1").arg(setupModel.ready ? qsTr("ready") : qsTr("not ready")); Accessible.name: text }
            }
            Controls.Label { text: setupModel.ready ? qsTr("Catalog ready") : qsTr("Catalog not ready: %1").arg(setupModel.errorMessage); color: setupModel.ready ? Kirigami.Theme.positiveTextColor : Kirigami.Theme.negativeTextColor; Accessible.name: text }
            Controls.Label { visible: setupModel.ready && setupModel.errorMessage.length > 0; text: qsTr("Could not save: %1").arg(setupModel.errorMessage); color: Kirigami.Theme.negativeTextColor; Accessible.name: text }
            Kirigami.Heading { text: qsTr("Connection map"); level: 3 }
            Controls.Label { text: qsTr("Computer → %1: %2").arg(selectedStorageLabel()).arg(routeDescription()); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Kirigami.Card { Layout.fillWidth: true
                header: Controls.Label { text: qsTr("Storage — %1").arg(selectedStorageLabel()); Accessible.name: text }
                contentItem: Controls.Label { text: storage.currentIndex < 0 ? qsTr("No external storage detected") : (!setupModel.storages[storage.currentIndex + 1].present ? qsTr("Missing") : qsTr("Present")); Accessible.name: text }
            }
            Controls.Label { text: qsTr("Choose folders and how Local Drive should handle files. Copy is the safe default; Move copies and verifies before source cleanup."); wrapMode: Text.WordWrap; Layout.fillWidth: true; Accessible.name: text }
            Controls.Label { text: qsTr("Source folder"); Accessible.name: text }
            RowLayout { Layout.fillWidth: true
                Controls.TextField { id: source; placeholderText: "/path/to/source"; Layout.fillWidth: true; Accessible.name: qsTr("Source folder path") }
                Controls.Button { text: qsTr("Choose…"); Accessible.name: qsTr("Choose source folder"); onClicked: sourceDialog.open() }
            }
            Controls.Label { text: qsTr("Destination storage"); Accessible.name: text }
            Controls.ComboBox { id: storage; model: setupModel.storages.slice(1); textRole: "label"; valueRole: "id"; currentIndex: 0; Layout.fillWidth: true; Accessible.name: qsTr("Destination storage") }
            Controls.Label { text: qsTr("Destination folder"); Accessible.name: text }
            RowLayout { Layout.fillWidth: true
                Controls.TextField { id: destination; placeholderText: "/path/on/storage"; Layout.fillWidth: true; Accessible.name: qsTr("Destination folder path") }
                Controls.Button { text: qsTr("Choose…"); Accessible.name: qsTr("Choose destination folder"); onClicked: destinationDialog.open() }
            }
            Controls.Label { text: qsTr("Behavior"); Accessible.name: text }
            Controls.ComboBox { id: behavior; model: [qsTr("Copy"), qsTr("Move")]; currentIndex: 0; Layout.fillWidth: true; Accessible.name: qsTr("Copy or Move") }
            Controls.Button { text: qsTr("Save route policy"); enabled: setupModel.ready && storage.currentIndex >= 0 && source.text.length > 0 && destination.text.length > 0; Accessible.name: qsTr("Save route policy"); onClicked: setupModel.saveRoute(source.text, storage.currentValue, destination.text, behavior.currentIndex === 0 ? "Copy" : "Move") }
            Kirigami.Heading { text: qsTr("Saved routes"); level: 2 }
            Repeater { model: setupModel.routes; delegate: Kirigami.Card { Layout.fillWidth: true
                contentItem: ColumnLayout {
                    Controls.Label { text: qsTr("%1 → %2: %3").arg(modelData.source).arg(modelData.destination).arg(modelData.behavior === "Copy" ? qsTr("Copy and verify; keep source") : qsTr("Move policy saved; execution unavailable until verified cleanup is implemented")); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    RowLayout {
                        Controls.Button { text: qsTr("Preview"); enabled: modelData.behavior === "Copy" && !copyEngine.running; onClicked: { previewRouteId = modelData.id; copyEngine.previewRoute(modelData.id) } }
                        Controls.Button { text: qsTr("Start Copy"); enabled: modelData.behavior === "Copy" && previewRouteId === modelData.id && selectedPreview.ok === true && copyEngine.previewSuccessful && !copyEngine.running; onClicked: copyEngine.startCopy() }
                        Controls.Button { text: qsTr("Cancel"); enabled: previewRouteId === modelData.id && copyEngine.running; onClicked: copyEngine.cancel() }
                    }
                    Controls.Label { visible: previewRouteId === modelData.id && selectedPreview.ok === true; text: qsTr("Preview: %1 files · %2 bytes · to copy %3 · identical %4 · conflicts %5 · unsupported %6 · free %7").arg(selectedPreview.files).arg(selectedPreview.bytes).arg(selectedPreview.toCopy).arg(selectedPreview.identical).arg(selectedPreview.conflicts).arg(selectedPreview.unsupported).arg(selectedPreview.freeBytes); wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { visible: previewRouteId === modelData.id && selectedPreview.ok === false && selectedPreview.error !== undefined && selectedPreview.error.length > 0; text: qsTr("Preview failed: %1").arg(selectedPreview.error); color: Kirigami.Theme.negativeTextColor; wrapMode: Text.Wrap; Layout.fillWidth: true; Accessible.name: text }
                    Controls.Label { visible: previewRouteId === modelData.id && copyEngine.status.length > 0; text: copyEngine.status; Layout.fillWidth: true; Accessible.name: text }
                }
            } }
        }
    }
    Connections { target: copyEngine; function onPreviewChanged() { selectedPreview = copyEngine.previewData } }
    FolderDialog { id: sourceDialog; title: qsTr("Choose source folder"); onAccepted: source.text = setupModel.pathFromUrl(selectedFolder) }
    FolderDialog { id: destinationDialog; title: qsTr("Choose destination folder"); currentFolder: storage.currentIndex >= 0 ? "file://" + setupModel.storages[storage.currentIndex + 1].root : ""; onAccepted: destination.text = setupModel.pathFromUrl(selectedFolder) }
}
