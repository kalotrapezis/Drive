# Έλεγχος αντιστοίχισης C++ / API / web — 2026-09-04

> Historical audit from 2026-09-04. Its wireless recommendation is deferred until after the wired beta. Current priorities and newer implemented work are in [Plan-V2.md](Plan-V2.md).

Ο C++/Qt πυρήνας παραμένει ενεργός. Το React/TypeScript αντικατέστησε το QML ως κύρια διεπαφή. Ο πίνακας καταγράφει τον τρέχοντα κώδικα, όχι υπόσχεση πλήρους λειτουργικότητας της παλιάς διεπαφής.

| Λειτουργία | Backend και API | Κατάσταση web |
|---|---|---|
| Copy / preview / έλεγχος hash | `VerifiedCopy`, `route-preview`, `route-execute` | Συνδεδεμένα στις κάρτες |
| Move / διατήρηση / Trash | `cleanupPreview`, `route-cleanup` | Συνδεδεμένα, ξεχωριστή επιβεβαίωση |
| Pause / resume / cancel | `routeControl` | Υπήρχαν στην αρχική κάρτα. Προστέθηκαν ενεργές εργασίες στο `state.operations` και χειρισμοί στο dashboard, ώστε να μη χάνονται με αλλαγή σελίδας |
| Ιστορικό / manifest | `recentHistory`, `route-history`, `route-manifest` | Συνδεδεμένα |
| Αντιγραφή χάρτη Drive σε Photos | `cloneDriveMapToPhotos`, `clone-files-map` | Υπήρχε API χωρίς χειρισμό. Προστέθηκε κουμπί όταν δεν υπάρχουν συνδέσεις Photos |
| Απόκρυψη / επανεμφάνιση / αφαίρεση | `SetupModel`, αντίστοιχα endpoints | Συνδεδεμένα, αρχεία και ιστορικό διατηρούνται |
| Cache εισερχόμενων | Εισαγωγή USB/MTP στο source library, ποσοστιαία εφεδρεία χώρου | Αφαιρέθηκε από τις εξερχόμενες κάρτες computer → disk. Προβάλλεται χωριστά από `state.incomingConnections`, με ένδειξη δυνατότητας από το API |
| Προγραμματισμός | `syncschedule.h`, `scheduleAction`, `checkSchedules` | Συνδεδεμένος, εκκρεμότητες και χειροκίνητη επανεκκίνηση |
| Ασύρματος δέκτης με αποθηκευμένο ασφαλές προφίλ | `WirelessReceiverController::start/stop` | Προστέθηκαν πραγματική κατάσταση και start/stop μέσω `wireless-control`. Δεν ξεκινά αυτόματα από αυτόν τον έλεγχο |
| Δημιουργία / εισαγωγή / εξαγωγή ασφαλούς προφίλ | `exportProfile`, `acceptPairingProfile`, native QML | **Ακόμη χωρίς πλήρη web διαδρομή**. Το QR scanner αποκωδικοποιεί κείμενο, δεν κάνει ασφαλές pairing |
| Συσχέτιση ασύρματης και USB ταυτότητας | `SetupModel::pairWirelessDevice` | **Χωρίς web χειρισμό/API**. Δεν είναι το ίδιο με αποδοχή πιστοποιητικού |
| Λήψη / αμφίδρομες συνδέσεις μεταξύ PC/server | `updateRouteRelationship` απορρίπτει `receive=true` | **Κενό backend**, όχι απλώς γκρίζο κουμπί στο web |
| Cache σε κάθε εισερχόμενη PC/server σύνδεση | Επιθυμητός κανόνας: δυνατότητα του παραλήπτη-υπολογιστή, ανεξάρτητα από πηγή/μεταφορά | Η υπάρχουσα διαδρομή Cache είναι USB/MTP. Γενικός ασύρματος ενδιάμεσος κόμβος και χάρτης πολλών υπολογιστών **δεν έχουν υλοποιηθεί**· δεν παρουσιάζονται ως έτοιμοι |
| Metadata / Pending backup | `pending_metadata`, `catalogState`, native wireless metadata handling | Προβάλλονται οι καταγεγραμμένες εκκρεμότητες. Η ύπαρξη συσκευής στο UI δεν αποδεικνύει σύνδεση ή ολοκληρωμένο pairing |
| Αρχεία / φωτογραφίες / εργασίες διόρθωσης | `file-action`, `photos`, `problem-action` | Έχουν API/UI. Δεν επανελέγχθηκαν όλες οι υπολειτουργίες σε αυτό το πέρασμα |

Κρίσιμα σημεία κώδικα: `src/main.cpp`, `src/localapi.cpp`, `src/setupmodel.h/.cpp`, `src/wirelessreceivercontroller.h/.cpp`, `src/qml/Main.qml`, `web/src/App.tsx`, `web/src/BackendActivity.tsx`.

Επόμενο ουσιαστικό κενό: ολοκλήρωση του ασφαλούς pairing/profile lifecycle στο API και web, και έπειτα γενικός χάρτης εισερχόμενων προς υπολογιστή. Η συσχέτιση ταυτοτήτων, η εμπιστοσύνη πιστοποιητικού και ο προορισμός μεταφοράς πρέπει να παραμένουν διακριτά.
