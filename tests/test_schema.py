import sqlite3
import tempfile
import unittest
from pathlib import Path


SCHEMA = Path(__file__).parents[1] / "src" / "catalog" / "schema.sql"


class CatalogSchemaTest(unittest.TestCase):
    def test_safe_catalog_persists_verified_copy(self):
        with tempfile.NamedTemporaryFile(suffix=".sqlite") as db_file:
            db = sqlite3.connect(db_file.name)
            db.execute("PRAGMA foreign_keys = ON")
            db.executescript(SCHEMA.read_text())
            db.executescript("""
                INSERT INTO devices(id, stable_id, name, kind, is_local)
                VALUES ('dev-1', 'machine-uuid', 'Laptop', 'Laptop', 1);
                INSERT INTO storage(id, stable_identity, device_id, kind, label, selected_root, presence)
                VALUES ('src', 'rootfs-uuid', 'dev-1', 'local', 'Source', '/home/test', 'present');
                INSERT INTO storage(id, stable_identity, device_id, kind, label, selected_root, presence)
                VALUES ('dst', 'disk-uuid', 'dev-1', 'removable', 'T7', '/mnt/T7', 'present');
                INSERT INTO routes(id, source_storage_id, destination_storage_id, source_root, destination_root)
                VALUES ('route-1', 'src', 'dst', '/home/test', '/mnt/T7/Local Drive');
                INSERT INTO routes(id, source_storage_id, destination_storage_id, source_root, destination_root, content_type)
                VALUES ('route-photos', 'src', 'dst', '/home/test/photos', '/mnt/T7/Local Drive/Photos', 'Photos');
                INSERT INTO content(id, sha256, size_bytes, original_name)
                VALUES ('content-1', lower(hex(zeroblob(32))), 5, 'a.txt');
                INSERT INTO jobs(id, route_id, behavior, source_path, destination_path, bytes_total)
                VALUES ('job-1', 'route-1', 'Copy', '/home/test/a.txt', '/mnt/T7/Local Drive/a.txt', 5);
                INSERT INTO job_items(id, job_id, content_id, source_path, destination_path, expected_size,
                                      expected_sha256, bytes_done, state, destination_sha256, verified_at)
                VALUES ('item-1', 'job-1', 'content-1', '/home/test/a.txt', '/mnt/T7/Local Drive/a.txt', 5,
                        lower(hex(zeroblob(32))), 5, 'Verified', lower(hex(zeroblob(32))), '2026-08-23T12:00:00Z');
                INSERT INTO locations(id, content_id, storage_id, relative_path, state, size_bytes,
                                      source_sha256, destination_sha256, verified_at)
                VALUES ('loc-1', 'content-1', 'dst', 'a.txt', 'verified', 5,
                        lower(hex(zeroblob(32))), lower(hex(zeroblob(32))), '2026-08-23T12:00:00Z');
                INSERT INTO history(id, origin_device_id, catalog_generation, origin_sequence, job_id, item_id,
                                    event, source_sha256, destination_sha256, result)
                VALUES ('event-1', 'dev-1', 1, 1, 'job-1', 'item-1', 'verified',
                        lower(hex(zeroblob(32))), lower(hex(zeroblob(32))), 'destination receipt');
            """)
            self.assertEqual(db.execute("SELECT state FROM locations WHERE id='loc-1'").fetchone()[0], "verified")
            self.assertEqual(db.execute("SELECT event FROM history WHERE id='event-1'").fetchone()[0], "verified")
            self.assertEqual(db.execute("SELECT version FROM schema_version").fetchone()[0], 17)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM device_aliases").fetchone()[0], 0)
            db.execute("INSERT INTO review_items(id,category,source_kind,source_id,title,item_count) VALUES ('review-1','Duplicates','import','preview-1','Review copies',2)")
            self.assertEqual(db.execute("SELECT item_count FROM review_items WHERE id='review-1'").fetchone()[0], 2)
            db.execute("INSERT INTO managed_inventory(route_id,relative_path,size_bytes,modified_ms,content_sha256) VALUES ('route-1','manual.txt',5,1,lower(hex(zeroblob(32))))")
            db.execute("INSERT INTO inventory_events(id,origin_device_id,catalog_generation,origin_sequence,route_id,event,relative_path,current_sha256,size_bytes) VALUES ('inventory-1','dev-1',1,2,'route-1','added','manual.txt',lower(hex(zeroblob(32))),5)")
            db.execute("INSERT INTO review_resolutions(id,origin_device_id,catalog_generation,origin_sequence,review_item_id,action,evidence_sha256) VALUES ('resolution-1','dev-1',1,3,'review-1','save',lower(hex(zeroblob(32))))")
            db.execute("INSERT INTO review_resolutions(id,origin_device_id,catalog_generation,origin_sequence,review_item_id,action,evidence_sha256) VALUES ('resolution-2','dev-1',1,4,'review-1','accept_existing',lower(hex(zeroblob(32))))")
            db.execute("INSERT INTO review_resolutions(id,origin_device_id,catalog_generation,origin_sequence,review_item_id,action,evidence_sha256) VALUES ('resolution-3','dev-1',1,5,'review-1','keep_both',lower(hex(zeroblob(32))))")
            db.execute("INSERT INTO review_resolutions(id,origin_device_id,catalog_generation,origin_sequence,review_item_id,action,evidence_sha256) VALUES ('resolution-4','dev-1',1,6,'review-1','skip_unsupported',lower(hex(zeroblob(32))))")
            db.execute("INSERT INTO device_corrections(id,target_device_id,action,source_root,relative_path,expected_size,expected_sha256) VALUES ('correction-1','dev-1','recheck_location','Drive','a.txt',5,lower(hex(zeroblob(32))))")
            db.execute("INSERT INTO device_correction_results(id,correction_id,origin_device_id,status,observed_size,observed_sha256) VALUES ('correction-result-1','correction-1','dev-1','verified',5,lower(hex(zeroblob(32))))")
            for table in ("devices", "storage"):
                columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
                self.assertTrue({"onboarding_seen", "hidden"} <= columns)
            db.execute("UPDATE storage SET bytes_total=1000,bytes_free=250 WHERE id='dst'")
            self.assertEqual(db.execute("SELECT bytes_total,bytes_free FROM storage WHERE id='dst'").fetchone(), (1000, 250))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE storage SET bytes_free=-1 WHERE id='dst'")
            self.assertEqual(db.execute("SELECT keep_policy FROM routes WHERE id='route-1'").fetchone()[0], "Everything")
            self.assertEqual(db.execute("SELECT content_type FROM routes WHERE id='route-1'").fetchone()[0], "Drive")
            self.assertEqual(db.execute("SELECT content_type FROM routes WHERE id='route-photos'").fetchone()[0], "Photos")
            self.assertIsNone(db.execute("SELECT staging_root FROM routes WHERE id='route-1'").fetchone()[0])

            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO routes(id, source_storage_id, destination_storage_id, source_root, destination_root, content_type) VALUES ('invalid-type', 'src', 'dst', '/home/invalid', '/mnt/T7/invalid', 'Archive')")

            db.execute("INSERT INTO locations(id, content_id, storage_id, relative_path, state, size_bytes) VALUES ('safe', 'content-1', 'dst', 'photo..jpg', 'present', 5)")
            for unsafe_path in ("..", "../x", "x/../y", "x/.."):
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("INSERT INTO locations(id, content_id, storage_id, relative_path, state, size_bytes) VALUES (?, 'content-1', 'dst', ?, 'present', 5)", ("bad-" + unsafe_path.replace('/', '-'), unsafe_path))

            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO storage(id, stable_identity, device_id, kind, label, selected_root) VALUES ('dup', 'disk-uuid', 'dev-1', 'removable', 'Other', '/mnt/other')")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO locations(id, content_id, storage_id, relative_path, state, size_bytes) VALUES ('bad', 'content-1', 'dst', 'bad.txt', 'verified', 5)")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO job_items(id, job_id, content_id, source_path, destination_path, state, cleanup_state, verified_at, expected_sha256, destination_sha256) VALUES ('bad-item', 'job-1', 'content-1', 'src', 'dst', 'Copying', 'pending', '2026-08-23T12:00:00Z', lower(hex(zeroblob(32))), lower(hex(zeroblob(31)) || 'ff'))")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE history SET result='changed' WHERE id='event-1'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE device_corrections SET relative_path='b.txt' WHERE id='correction-1'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM inventory_events WHERE id='inventory-1'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE review_resolutions SET result_state='failed' WHERE id='resolution-1'")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO review_items(id,category,source_kind,source_id,title) VALUES ('bad-review','Other','import','preview-2','Bad')")
            db.close()


if __name__ == "__main__":
    unittest.main()
