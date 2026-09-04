-- Local Drive 0.1 catalog. File contents remain ordinary filesystem files.

CREATE TABLE schema_version (
    singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
    version         INTEGER NOT NULL CHECK (version >= 1),
    installed_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO schema_version(singleton, version) VALUES (1, 17);

CREATE TABLE app_config (
    singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
    config_revision INTEGER NOT NULL DEFAULT 0 CHECK (config_revision >= 0),
    hub_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (hub_enabled IN (0, 1)),
    hub_limit_percent INTEGER NOT NULL DEFAULT 80 CHECK (hub_limit_percent BETWEEN 1 AND 95),
    updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO app_config(singleton) VALUES (1);

CREATE TABLE devices (
    id              TEXT PRIMARY KEY,
    stable_id       TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
    kind            TEXT NOT NULL CHECK (kind IN ('Server', 'Desktop', 'Laptop', 'Tablet', 'Phone')),
    catalog_generation INTEGER NOT NULL DEFAULT 1 CHECK (catalog_generation > 0),
    event_sequence  INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
    is_local        INTEGER NOT NULL DEFAULT 0 CHECK (is_local IN (0, 1)),
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at    TEXT,
    last_inventory_at TEXT,
    onboarding_seen INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_seen IN (0, 1)),
    hidden          INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
);
CREATE UNIQUE INDEX one_local_device ON devices(is_local) WHERE is_local = 1;

CREATE TABLE device_aliases (
    alias        TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    transport    TEXT NOT NULL CHECK (transport IN ('mtp', 'wireless')),
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE storage (
    id              TEXT PRIMARY KEY,
    stable_identity TEXT NOT NULL UNIQUE,
    device_id       TEXT NOT NULL REFERENCES devices(id),
    kind            TEXT NOT NULL CHECK (kind IN ('local', 'removable', 'mtp')),
    label           TEXT NOT NULL CHECK (length(trim(label)) > 0),
    filesystem_type TEXT,
    selected_root   TEXT NOT NULL CHECK (selected_root <> '' AND substr(selected_root, 1, 1) = '/'),
    presence        TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (presence IN ('present', 'missing', 'offline', 'unknown')),
    last_seen_at    TEXT,
    last_verified_at TEXT,
    bytes_total     INTEGER CHECK (bytes_total IS NULL OR bytes_total >= 0),
    bytes_free      INTEGER CHECK (bytes_free IS NULL OR bytes_free >= 0),
    onboarding_seen INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_seen IN (0, 1)),
    hidden          INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
);

CREATE TABLE routes (
    id              TEXT PRIMARY KEY,
    source_storage_id TEXT NOT NULL REFERENCES storage(id),
    destination_storage_id TEXT NOT NULL REFERENCES storage(id),
    source_root     TEXT NOT NULL CHECK (source_root <> ''),
    destination_root TEXT NOT NULL CHECK (destination_root <> ''),
    behavior        TEXT NOT NULL DEFAULT 'Copy' CHECK (behavior IN ('Copy', 'Move')),
    keep_policy     TEXT NOT NULL DEFAULT 'Everything' CHECK (keep_policy IN ('Everything', 'Last month', 'Last week', 'Last day', 'Nothing')),
    content_type    TEXT NOT NULL DEFAULT 'Drive' CHECK (content_type IN ('Drive', 'Photos')),
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    staging_max_bytes INTEGER CHECK (staging_max_bytes IS NULL OR staging_max_bytes >= 0),
    staging_root    TEXT CHECK (staging_root IS NULL OR staging_root <> ''),
    minimum_free_bytes INTEGER CHECK (minimum_free_bytes IS NULL OR minimum_free_bytes >= 0),
    organize_photos INTEGER NOT NULL DEFAULT 0 CHECK (organize_photos IN (0, 1)),
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (source_storage_id <> destination_storage_id OR source_root <> destination_root)
);

CREATE TABLE content (
    id              TEXT PRIMARY KEY,
    sha256          TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-fA-F]*'),
    size_bytes      INTEGER NOT NULL CHECK (size_bytes >= 0),
    type_hint       TEXT,
    original_name   TEXT,
    created_at      TEXT,
    captured_at     TEXT,
    modified_at     TEXT,
    UNIQUE (sha256, size_bytes)
);

CREATE TABLE locations (
    id              TEXT PRIMARY KEY,
    content_id      TEXT NOT NULL REFERENCES content(id),
    storage_id      TEXT NOT NULL REFERENCES storage(id),
    relative_path   TEXT NOT NULL CHECK (relative_path <> '' AND relative_path NOT LIKE '/%' AND relative_path <> '..' AND relative_path NOT LIKE '../%' AND relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE '%/..'),
    state           TEXT NOT NULL CHECK (state IN ('partial', 'present', 'verified', 'trashed', 'deleted', 'unknown')),
    size_bytes      INTEGER NOT NULL CHECK (size_bytes >= 0),
    source_sha256   TEXT,
    destination_sha256 TEXT,
    verified_at     TEXT,
    last_seen_at    TEXT,
    last_verified_at TEXT,
    UNIQUE (storage_id, relative_path),
    CHECK (source_sha256 IS NULL OR (length(source_sha256) = 64 AND source_sha256 = lower(source_sha256) AND source_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK (destination_sha256 IS NULL OR (length(destination_sha256) = 64 AND destination_sha256 = lower(destination_sha256) AND destination_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK (state <> 'verified' OR (verified_at IS NOT NULL AND source_sha256 IS NOT NULL AND destination_sha256 = source_sha256)),
    CHECK (state <> 'partial' OR verified_at IS NULL)
);

CREATE TABLE jobs (
    id              TEXT PRIMARY KEY,
    route_id        TEXT NOT NULL REFERENCES routes(id),
    behavior        TEXT NOT NULL CHECK (behavior IN ('Copy', 'Move')),
    keep_policy     TEXT NOT NULL DEFAULT 'Everything' CHECK (keep_policy IN ('Everything', 'Last month', 'Last week', 'Last day', 'Nothing')),
    state           TEXT NOT NULL DEFAULT 'Queued'
                    CHECK (state IN ('Queued', 'Copying', 'Verifying', 'Verified', 'Cleanup pending', 'Complete', 'Paused', 'Cancelled', 'Conflict', 'Failed')),
    source_path     TEXT NOT NULL CHECK (source_path <> ''),
    destination_path TEXT NOT NULL CHECK (destination_path <> ''),
    bytes_total     INTEGER NOT NULL DEFAULT 0 CHECK (bytes_total >= 0),
    bytes_done      INTEGER NOT NULL DEFAULT 0 CHECK (bytes_done >= 0 AND bytes_done <= bytes_total),
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at    TEXT,
    error_code      TEXT,
    error_message   TEXT
);

CREATE TABLE job_items (
    id              TEXT PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id),
    source_path     TEXT NOT NULL CHECK (source_path <> ''),
    destination_path TEXT NOT NULL CHECK (destination_path <> ''),
    expected_size   INTEGER CHECK (expected_size IS NULL OR expected_size >= 0),
    expected_sha256 TEXT,
    bytes_done      INTEGER NOT NULL DEFAULT 0 CHECK (bytes_done >= 0),
    state           TEXT NOT NULL DEFAULT 'Queued'
                    CHECK (state IN ('Queued', 'Copying', 'Verifying', 'Verified', 'Cleanup pending', 'Complete', 'Paused', 'Cancelled', 'Conflict', 'Failed')),
    source_mtime   TEXT,
    destination_sha256 TEXT,
    verified_at     TEXT,
    cleanup_state   TEXT NOT NULL DEFAULT 'not_requested'
                   CHECK (cleanup_state IN ('not_requested', 'pending', 'trashed', 'failed')),
    CHECK (expected_sha256 IS NULL OR (length(expected_sha256) = 64 AND expected_sha256 = lower(expected_sha256) AND expected_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK (destination_sha256 IS NULL OR (length(destination_sha256) = 64 AND destination_sha256 = lower(destination_sha256) AND destination_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK (state NOT IN ('Verified', 'Cleanup pending', 'Complete') OR (expected_sha256 IS NOT NULL AND destination_sha256 = expected_sha256 AND verified_at IS NOT NULL)),
    CHECK (cleanup_state NOT IN ('pending', 'trashed') OR (expected_sha256 IS NOT NULL AND destination_sha256 = expected_sha256 AND verified_at IS NOT NULL))
);

CREATE TABLE history (
    id              TEXT PRIMARY KEY,
    origin_device_id TEXT NOT NULL REFERENCES devices(id),
    catalog_generation INTEGER NOT NULL CHECK (catalog_generation > 0),
    origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),
    job_id          TEXT REFERENCES jobs(id),
    item_id         TEXT REFERENCES job_items(id),
    event           TEXT NOT NULL CHECK (event IN ('queued', 'copying', 'verifying', 'verified', 'moved', 'trashed', 'conflict', 'failed', 'cancelled', 'retried')),
    source_path     TEXT,
    destination_path TEXT,
    source_sha256   TEXT,
    destination_sha256 TEXT,
    occurred_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    result          TEXT,
    UNIQUE (origin_device_id, catalog_generation, origin_sequence),
    CHECK (source_sha256 IS NULL OR (length(source_sha256) = 64 AND source_sha256 = lower(source_sha256) AND source_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK (destination_sha256 IS NULL OR (length(destination_sha256) = 64 AND destination_sha256 = lower(destination_sha256) AND destination_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK (event <> 'verified' OR (source_sha256 IS NOT NULL AND destination_sha256 = source_sha256))
);

CREATE TABLE metadata_events (
    id                  TEXT PRIMARY KEY,
    origin_device_id    TEXT NOT NULL REFERENCES devices(id),
    catalog_generation  INTEGER NOT NULL CHECK (catalog_generation > 0),
    origin_sequence     INTEGER NOT NULL CHECK (origin_sequence > 0),
    item_id             TEXT NOT NULL CHECK (item_id <> ''),
    source_root         TEXT NOT NULL CHECK (source_root IN ('Drive', 'DCIM')),
    relative_path       TEXT NOT NULL CHECK (relative_path <> '' AND relative_path NOT LIKE '/%' AND relative_path <> '..' AND relative_path NOT LIKE '../%' AND relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE '%/..'),
    size_bytes          INTEGER NOT NULL CHECK (size_bytes >= 0),
    modified_at         INTEGER NOT NULL CHECK (modified_at >= 0),
    captured_at         TEXT,
    type_hint           TEXT,
    media_metadata      TEXT NOT NULL DEFAULT '{}',
    content_sha256      TEXT,
    received_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (origin_device_id, catalog_generation, origin_sequence),
    CHECK (content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 = lower(content_sha256) AND content_sha256 NOT GLOB '*[^0-9a-f]*'))
);

CREATE TABLE pending_metadata (
    origin_device_id    TEXT NOT NULL REFERENCES devices(id),
    item_id             TEXT NOT NULL CHECK (item_id <> ''),
    source_root         TEXT NOT NULL CHECK (source_root IN ('Drive', 'DCIM')),
    relative_path       TEXT NOT NULL,
    size_bytes          INTEGER NOT NULL CHECK (size_bytes >= 0),
    modified_at         INTEGER NOT NULL CHECK (modified_at >= 0),
    captured_at         TEXT,
    type_hint           TEXT,
    media_metadata      TEXT NOT NULL DEFAULT '{}',
    content_sha256      TEXT,
    origin_sequence     INTEGER NOT NULL CHECK (origin_sequence > 0),
    state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete', 'review')),
    updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (origin_device_id, item_id),
    CHECK (content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 = lower(content_sha256) AND content_sha256 NOT GLOB '*[^0-9a-f]*'))
);

CREATE TABLE metadata_cursors (
    origin_device_id    TEXT NOT NULL REFERENCES devices(id),
    catalog_generation  INTEGER NOT NULL CHECK (catalog_generation > 0),
    highest_contiguous  INTEGER NOT NULL DEFAULT 0 CHECK (highest_contiguous >= 0),
    updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (origin_device_id, catalog_generation)
);

CREATE TABLE review_items (
    id              TEXT PRIMARY KEY,
    category        TEXT NOT NULL CHECK (category IN ('Duplicates', 'Conflicts', 'Permissions', 'Transfers', 'Storage', 'External changes', 'Unsupported')),
    source_kind     TEXT NOT NULL CHECK (source_kind IN ('import', 'job', 'metadata', 'system')),
    source_id       TEXT NOT NULL CHECK (source_id <> ''),
    title           TEXT NOT NULL CHECK (title <> ''),
    summary         TEXT NOT NULL DEFAULT '',
    details_json    TEXT NOT NULL DEFAULT '{}',
    item_count      INTEGER NOT NULL DEFAULT 1 CHECK (item_count > 0),
    bytes_total     INTEGER NOT NULL DEFAULT 0 CHECK (bytes_total >= 0),
    state           TEXT NOT NULL DEFAULT 'needs_decision'
                    CHECK (state IN ('needs_decision', 'needs_device', 'can_retry', 'saved', 'resolved', 'dismissed')),
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at     TEXT,
    UNIQUE (source_kind, source_id, category)
);

CREATE TABLE managed_inventory (
    route_id         TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    relative_path    TEXT NOT NULL CHECK (relative_path <> '' AND relative_path NOT LIKE '/%' AND relative_path <> '..' AND relative_path NOT LIKE '../%' AND relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE '%/..'),
    size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
    modified_ms      INTEGER NOT NULL CHECK (modified_ms >= 0),
    content_sha256   TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 = lower(content_sha256) AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
    state            TEXT NOT NULL DEFAULT 'present' CHECK (state IN ('present', 'missing')),
    first_seen_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (route_id, relative_path)
);

CREATE TABLE inventory_events (
    id                  TEXT PRIMARY KEY,
    origin_device_id    TEXT NOT NULL REFERENCES devices(id),
    catalog_generation  INTEGER NOT NULL CHECK (catalog_generation > 0),
    origin_sequence     INTEGER NOT NULL CHECK (origin_sequence > 0),
    route_id            TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    event               TEXT NOT NULL CHECK (event IN ('added', 'changed', 'missing', 'reappeared')),
    relative_path       TEXT NOT NULL,
    previous_sha256     TEXT,
    current_sha256      TEXT,
    size_bytes          INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    occurred_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (origin_device_id, catalog_generation, origin_sequence),
    CHECK (previous_sha256 IS NULL OR (length(previous_sha256) = 64 AND previous_sha256 = lower(previous_sha256) AND previous_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK (current_sha256 IS NULL OR (length(current_sha256) = 64 AND current_sha256 = lower(current_sha256) AND current_sha256 NOT GLOB '*[^0-9a-f]*'))
);

CREATE TABLE review_resolutions (
    id                  TEXT PRIMARY KEY,
    origin_device_id    TEXT NOT NULL REFERENCES devices(id),
    catalog_generation  INTEGER NOT NULL CHECK (catalog_generation > 0),
    origin_sequence     INTEGER NOT NULL CHECK (origin_sequence > 0),
    review_item_id      TEXT NOT NULL REFERENCES review_items(id),
    action              TEXT NOT NULL CHECK (action IN ('save', 'dismiss', 'accept_existing', 'keep_both', 'skip_unsupported')),
    evidence_sha256     TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 = lower(evidence_sha256) AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
    details_json        TEXT NOT NULL DEFAULT '{}',
    result_state        TEXT NOT NULL DEFAULT 'applied_local' CHECK (result_state IN ('applied_local', 'pending_device', 'failed')),
    occurred_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (origin_device_id, catalog_generation, origin_sequence)
);

CREATE TABLE device_corrections (
    id                  TEXT PRIMARY KEY,
    target_device_id    TEXT NOT NULL REFERENCES devices(id),
    review_item_id      TEXT REFERENCES review_items(id),
    action              TEXT NOT NULL CHECK (action = 'recheck_location'),
    source_root         TEXT NOT NULL CHECK (source_root IN ('Drive', 'DCIM')),
    relative_path       TEXT NOT NULL CHECK (relative_path <> '' AND relative_path NOT LIKE '/%' AND relative_path <> '..' AND relative_path NOT LIKE '../%' AND relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE '%/..'),
    expected_size       INTEGER NOT NULL CHECK (expected_size >= 0),
    expected_sha256     TEXT NOT NULL CHECK (length(expected_sha256) = 64 AND expected_sha256 = lower(expected_sha256) AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE device_correction_results (
    id                  TEXT PRIMARY KEY,
    correction_id       TEXT NOT NULL UNIQUE REFERENCES device_corrections(id),
    origin_device_id    TEXT NOT NULL REFERENCES devices(id),
    status              TEXT NOT NULL CHECK (status IN ('verified', 'changed', 'missing', 'failed')),
    observed_size       INTEGER CHECK (observed_size IS NULL OR observed_size >= 0),
    observed_sha256     TEXT CHECK (observed_sha256 IS NULL OR (length(observed_sha256) = 64 AND observed_sha256 = lower(observed_sha256) AND observed_sha256 NOT GLOB '*[^0-9a-f]*')),
    error_message       TEXT NOT NULL DEFAULT '',
    completed_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER history_immutable_update
BEFORE UPDATE ON history
BEGIN
    SELECT RAISE(ABORT, 'history is append-only');
END;
CREATE TRIGGER history_immutable_delete
BEFORE DELETE ON history
BEGIN
    SELECT RAISE(ABORT, 'history is append-only');
END;
CREATE TRIGGER inventory_events_immutable_update
BEFORE UPDATE ON inventory_events
BEGIN
    SELECT RAISE(ABORT, 'inventory events are append-only');
END;
CREATE TRIGGER inventory_events_immutable_delete
BEFORE DELETE ON inventory_events
BEGIN
    SELECT RAISE(ABORT, 'inventory events are append-only');
END;
CREATE TRIGGER review_resolutions_immutable_update
BEFORE UPDATE ON review_resolutions
BEGIN
    SELECT RAISE(ABORT, 'review resolutions are append-only');
END;
CREATE TRIGGER review_resolutions_immutable_delete
BEFORE DELETE ON review_resolutions
BEGIN
    SELECT RAISE(ABORT, 'review resolutions are append-only');
END;

CREATE TRIGGER device_corrections_immutable_update
BEFORE UPDATE ON device_corrections
BEGIN
    SELECT RAISE(ABORT, 'device corrections are append-only');
END;

CREATE TRIGGER device_corrections_immutable_delete
BEFORE DELETE ON device_corrections
BEGIN
    SELECT RAISE(ABORT, 'device corrections are append-only');
END;

CREATE TRIGGER device_correction_results_immutable_update
BEFORE UPDATE ON device_correction_results
BEGIN
    SELECT RAISE(ABORT, 'device correction results are append-only');
END;

CREATE TRIGGER device_correction_results_immutable_delete
BEFORE DELETE ON device_correction_results
BEGIN
    SELECT RAISE(ABORT, 'device correction results are append-only');
END;
