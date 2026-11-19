-- Omnibus database shape (no data) of a long-running install, from the maintainer's backup of 2026-11-18 09:30.
-- freshInstall.test.js starts the app on this shape and on an empty database and compares them.

CREATE TABLE achievement_baseline (user_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, PRIMARY KEY (user_id, kind, ref_id));

CREATE TABLE achievement_completions (user_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (user_id, kind, ref_id));

CREATE TABLE achievement_counts (user_id TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, key));

CREATE TABLE achievement_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE ai_answer_cache (
      key        TEXT PRIMARY KEY,
      reply      TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, task TEXT, tier TEXT, provider TEXT, model TEXT,
  source TEXT DEFAULT 'live', ok INTEGER DEFAULT 1, error TEXT, ms INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read INTEGER DEFAULT 0, cache_write INTEGER DEFAULT 0, web_searches INTEGER DEFAULT 0, job_id TEXT, thinking_tokens INTEGER, run_id TEXT, cost REAL, request_id TEXT);

CREATE TABLE ai_feedback (
      usage_id   INTEGER PRIMARY KEY,         -- ai_usage.id of the answer
      user_id    TEXT,
      rating     INTEGER NOT NULL,            -- 1 up, -1 down
      question   TEXT,                        -- kept only for thumbs-down
      answer     TEXT,
      page       TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE ai_jobs (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL, task TEXT, tier TEXT, provider TEXT, model TEXT, source TEXT DEFAULT 'live',
  calls INTEGER DEFAULT 0, failed_calls INTEGER DEFAULT 0, ms INTEGER DEFAULT 0, outcome TEXT, detail TEXT);

CREATE TABLE ai_runs (id TEXT PRIMARY KEY, at INTEGER NOT NULL, label TEXT, user_id TEXT);

CREATE TABLE ai_selftest (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at  TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      status      TEXT,                       -- running | done | error
      results     TEXT,
      cost        REAL DEFAULT 0
    , label TEXT, models TEXT);

CREATE TABLE ai_usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT,
      day           TEXT NOT NULL,
      created_at    TEXT DEFAULT (datetime('now')),
      model         TEXT,
      input_tokens  INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read    INTEGER DEFAULT 0,
      cache_write   INTEGER DEFAULT 0,
      model_calls   INTEGER DEFAULT 0,
      tool_calls    INTEGER DEFAULT 0,
      escalated     INTEGER DEFAULT 0,
      ok            INTEGER DEFAULT 1,
      error         TEXT
    , web_searches INTEGER DEFAULT 0, kind TEXT);

CREATE TABLE arc_summaries (
    arc_key TEXT PRIMARY KEY,               -- series/context + exact first and last issue
    label TEXT, status TEXT NOT NULL,       -- ok | missing
    summary TEXT, source TEXT, source_url TEXT, model TEXT, confidence TEXT,
    est_cost REAL DEFAULT 0, created_at INTEGER NOT NULL, retry_after INTEGER
  );

CREATE TABLE assistant_phrases (   -- recent openings/endings, so he does not settle into a formula
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT,
      opening    TEXT,
      ending     TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    , stock TEXT, franchises TEXT, catchphrase INTEGER);

CREATE TABLE award_data (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    award       TEXT NOT NULL,
    year        INTEGER NOT NULL,
    category    TEXT NOT NULL,
    series_name TEXT NOT NULL,
    publisher   TEXT,
    winner      INTEGER DEFAULT 0, cv_volume_id TEXT, cv_issue_id TEXT, kind TEXT, creator TEXT, creators TEXT, cited_works TEXT, source TEXT,
    UNIQUE(award, year, category, series_name)
  );

CREATE TABLE book_ci_index (
      book_id      TEXT PRIMARY KEY,
      series_name  TEXT,
      name_key     TEXT,
      volume_year  INTEGER,
      number       TEXT,          -- <Number> as tagged (may be retagged)
      orig_number  TEXT,          -- number as published (from the CV link, else <Number>)
      cv_issue_id  TEXT,
      stamp        TEXT
    );

CREATE TABLE box_artwork_preferences (kind TEXT NOT NULL, box_id TEXT NOT NULL, choice TEXT NOT NULL, PRIMARY KEY(kind,box_id));

CREATE TABLE branding_assets (kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, image BLOB NOT NULL, version TEXT NOT NULL, scale REAL NOT NULL DEFAULT 1, aliases TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(kind,key));

CREATE TABLE canon_category_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES canon_runs(id) ON DELETE CASCADE,
    category TEXT NOT NULL, action TEXT NOT NULL, notes TEXT, current_notes TEXT, sources TEXT, created_at TEXT DEFAULT (datetime('now')), why TEXT,
    UNIQUE(run_id, category));

CREATE TABLE canon_run_categories (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           INTEGER NOT NULL REFERENCES canon_runs(id) ON DELETE CASCADE,
    category         TEXT NOT NULL,
    adaptation_notes TEXT,
    UNIQUE(run_id, category)
  );

CREATE TABLE canon_run_creators (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES canon_runs(id) ON DELETE CASCADE,
    person_name TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'writer'
  );

CREATE TABLE canon_run_issues (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           INTEGER NOT NULL REFERENCES canon_runs(id) ON DELETE CASCADE,
    cv_issue_id      TEXT,
    scanned_book_id  INTEGER REFERENCES scanned_books(id) ON DELETE SET NULL,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    series_name      TEXT,
    issue_number     TEXT,
    volume_year      TEXT,
    manually_matched INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE canon_runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT NOT NULL,
    parent_series    TEXT,
    cv_volume_id     TEXT,
    issue_range_hint TEXT,
    description      TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now'))
  , event_id INTEGER REFERENCES events(id) ON DELETE SET NULL, admin_recommended INTEGER DEFAULT 0, categories_checked_at TEXT, home_tagline TEXT, home_description TEXT);

CREATE TABLE collection_follows (
    user_id TEXT NOT NULL, collection_id TEXT NOT NULL, followed_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, collection_id));

CREATE TABLE collection_missing_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id TEXT NOT NULL,
    name TEXT NOT NULL, norm_name TEXT NOT NULL, start_year INTEGER, publisher TEXT, reason TEXT,
    cv_volume_id TEXT, cv_name TEXT, image_url TEXT, issue_count INTEGER, cv_checked_at TEXT,
    added_at TEXT DEFAULT (datetime('now')));

CREATE TABLE collection_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    rule_value TEXT NOT NULL,
    FOREIGN KEY (collection_id) REFERENCES collections(id)
  );

CREATE TABLE collection_series (
    collection_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    manually_added INTEGER DEFAULT 0,
    PRIMARY KEY (collection_id, series_id),
    FOREIGN KEY (collection_id) REFERENCES collections(id)
  );

CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    era TEXT,
    publisher TEXT,
    color_primary TEXT,
    color_secondary TEXT,
    cover_series_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  , condition_group TEXT, collection_type TEXT DEFAULT 'manual', cover_image TEXT, cover_position TEXT, owner_id TEXT, visibility TEXT DEFAULT 'public', sort_order INTEGER DEFAULT 0, library_id TEXT, purpose TEXT, card_description TEXT);

CREATE TABLE comicinfo_cache (
    series_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE cv_api_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,            -- ms since epoch, when the request was sent
    resource TEXT    NOT NULL,            -- first path segment after /api/
    lane     TEXT    NOT NULL,            -- interactive | background
    caller   TEXT,
    status   TEXT    DEFAULT 'pending',   -- HTTP status, 'refused', 'error'
    ms       INTEGER
  );

CREATE TABLE cv_backoff (
    resource TEXT PRIMARY KEY,
    until    INTEGER NOT NULL,
    reason   TEXT
  );

CREATE TABLE cv_character_cache (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    image_url TEXT,
    cv_id INTEGER,
    cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE cv_issue_volume (issue_id TEXT PRIMARY KEY, volume_id TEXT, volume_name TEXT, at INTEGER NOT NULL);

CREATE TABLE cv_person_cache (
  name       TEXT PRIMARY KEY,
  cv_person_id TEXT,
  image_url  TEXT,
  cached_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cv_volume_issues_cache (vol_id TEXT PRIMARY KEY, at INTEGER NOT NULL, issues TEXT NOT NULL);

CREATE TABLE cv_windows (
    resource TEXT PRIMARY KEY,
    start    INTEGER NOT NULL             -- ms; the window ends at start + 1 hour
  );

CREATE TABLE dismissed_continue_reading (
    user_id      TEXT NOT NULL,
    series_id    TEXT NOT NULL,
    dismissed_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, series_id)
  );

CREATE TABLE download_blacklist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id   TEXT    NOT NULL,
    url        TEXT    NOT NULL,
    reason     TEXT,
    failed_at  TEXT    DEFAULT (datetime('now')), kind TEXT DEFAULT 'retry',
    UNIQUE(issue_id, url)
  );

CREATE TABLE download_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL,
      list_id       INTEGER,
      list_issue_id INTEGER,
      series_name   TEXT,
      issue_number  TEXT,
      volume_year   INTEGER,
      cv_issue_id   TEXT,
      status        TEXT NOT NULL DEFAULT 'open',
      created_at    TEXT DEFAULT (datetime('now')),
      handled_at    TEXT,
      handled_by    TEXT
    , kind TEXT DEFAULT 'list_issue', scanned_series_id TEXT, publisher TEXT, note TEXT, source_id TEXT, source_issue_id TEXT);

CREATE TABLE essential_collections (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, position INTEGER NOT NULL DEFAULT 0, appearance_json TEXT NOT NULL DEFAULT '{}', pinned_json TEXT NOT NULL DEFAULT '[]', legacy_key TEXT);

CREATE TABLE event_issues (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    cv_issue_id     TEXT,
    scanned_book_id TEXT,
    sort_order      INTEGER NOT NULL,
    tier            TEXT DEFAULT 'recommended',
    tier_note       TEXT,
    series_name     TEXT NOT NULL,
    issue_number    TEXT NOT NULL,
    issue_title     TEXT
  , volume_year TEXT, manually_matched INTEGER DEFAULT 0, phase TEXT, sources TEXT, order_note TEXT, order_flag TEXT, tier_reason TEXT);

CREATE TABLE events (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    publisher    TEXT,
    year         INTEGER,
    cv_story_arc_id TEXT,
    description  TEXT,
    cover_image  TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  , event_tier INTEGER DEFAULT 2, sort_order INTEGER DEFAULT 0, source TEXT DEFAULT 'auto', generator_sources TEXT, notes_refreshed_at INTEGER, home_tagline TEXT, home_description TEXT, cover_issue_id INTEGER, draft INTEGER DEFAULT 0, initiative INTEGER NOT NULL DEFAULT 0, home_series_id TEXT, home_confirmed INTEGER NOT NULL DEFAULT 0, home_source TEXT);

CREATE TABLE guide_directory (site TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')));

CREATE TABLE identity_rebinds (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,          -- 'series' | 'book'
      mode        TEXT NOT NULL,          -- 'on' | 'dry_run'
      outcome     TEXT NOT NULL,          -- reclaimed | ambiguous | tombstoned (prefixed would_ in dry_run)
      entity_id   TEXT,
      old_path    TEXT,
      new_path    TEXT,
      match_key   TEXT,
      candidates  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE issue_story_arcs (
    cv_issue_id TEXT PRIMARY KEY, arcs TEXT, fetched_at INTEGER NOT NULL
  );

CREATE TABLE issue_synopses (
    issue_key TEXT PRIMARY KEY,            -- Comic Vine issue id, else "book:<id>"
    book_id TEXT,
    status TEXT NOT NULL,                  -- ok | missing
    synopsis TEXT,
    source TEXT,                           -- comicinfo | web | pages
    source_url TEXT,
    model TEXT,
    confidence TEXT,
    notes TEXT,                            -- page reading: the scene list (JSON), for checking errors
    est_cost REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    retry_after INTEGER
  );

CREATE TABLE libraries (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    icon       TEXT,
    color      TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  , scan_interval_hours INTEGER DEFAULT 0, last_scanned_at TEXT);

CREATE TABLE library_health_dismissed (
    kind TEXT NOT NULL, key TEXT NOT NULL, dismissed_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (kind, key));

CREATE TABLE library_health_reidentify (book_id TEXT PRIMARY KEY, note TEXT, added_at TEXT DEFAULT (datetime('now')));

CREATE TABLE library_status_checks (
    comicid    TEXT PRIMARY KEY,
    path       TEXT,
    checked_at INTEGER NOT NULL,      -- ms since epoch
    result     TEXT NOT NULL          -- ongoing | ended | unknown
  );

CREATE TABLE list_issues (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_kind         TEXT NOT NULL,
      owner_id           INTEGER NOT NULL,
      sort_order         REAL NOT NULL DEFAULT 0,
      cv_issue_id        TEXT,
      scanned_book_id    TEXT,
      scanned_series_id  TEXT,
      series_name        TEXT,
      issue_number       TEXT,
      issue_title        TEXT,
      volume_year        INTEGER,
      cover_date         TEXT,
      manually_matched   INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE locg_issue_lookup (
    locg_issue_id  TEXT PRIMARY KEY,
    locg_slug      TEXT NOT NULL,
    cv_series_id   TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  );

CREATE TABLE metadata_book_followups (
      operation_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')));

CREATE TABLE metadata_book_managed (
      book_id TEXT PRIMARY KEY, cv_issue_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      record TEXT NOT NULL);

CREATE TABLE metadata_book_revisions (
      book_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
      archive_revision TEXT NOT NULL, metadata_revision TEXT NOT NULL, page_revision TEXT NOT NULL);

CREATE TABLE metadata_jobs(book_id TEXT PRIMARY KEY,arrival TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',due_at INTEGER NOT NULL,last_error TEXT,checked_at INTEGER,observed_signature TEXT NOT NULL DEFAULT '', first_seen INTEGER, attempts INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, publication_date TEXT, date_basis TEXT, date_precision TEXT, group_key TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'enrichment', manual_requested_at INTEGER, last_success_at INTEGER, initial_pending INTEGER NOT NULL DEFAULT 0, milestone INTEGER, policy_version INTEGER NOT NULL DEFAULT 0, match_note TEXT, last_result TEXT);

CREATE TABLE metadata_last_batch(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL);

CREATE TABLE metadata_maintenance_control(id INTEGER PRIMARY KEY CHECK(id=1),paused INTEGER NOT NULL DEFAULT 0);

CREATE TABLE metadata_night_summary(id INTEGER PRIMARY KEY CHECK(id=1),record TEXT NOT NULL);

CREATE TABLE metadata_queue_groups(group_key TEXT PRIMARY KEY,last_served INTEGER NOT NULL DEFAULT 0);

CREATE TABLE metadata_upgrades(key TEXT PRIMARY KEY,applied_at INTEGER NOT NULL);

CREATE TABLE metadata_work_books (
        book_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);

CREATE TABLE metadata_work_completion (
        operation_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('cleanup_intent','complete')));

CREATE TABLE metadata_work_config (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL,
        path_policy TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0);

CREATE TABLE metadata_work_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL,
        at INTEGER NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL);

CREATE TABLE metadata_work_execution (
        operation_id TEXT PRIMARY KEY,
        checkpoint TEXT NOT NULL CHECK(checkpoint IN ('prepare_intent','prepared','backup_intent','backed_up','publish_intent','published','rollback_intent','rolled_back')),
        prepared TEXT, backup_started INTEGER NOT NULL DEFAULT 0,
        publish_started INTEGER NOT NULL DEFAULT 0);

CREATE TABLE metadata_work_finalization (
        operation_id TEXT PRIMARY KEY, book_id TEXT NOT NULL,
        receipt TEXT NOT NULL, finalized_at INTEGER NOT NULL);

CREATE TABLE metadata_work_operations (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        intent TEXT NOT NULL, book_id TEXT, book_generation INTEGER, owner_id TEXT NOT NULL,
        fence INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','recovery_required','released')),
        lease_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL, release_reason TEXT);

CREATE TABLE metadata_work_resources (
        operation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('book','path')),
        resource_key TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('exact','file','tree')),
        PRIMARY KEY(operation_id,kind,resource_key,scope));

CREATE TABLE metadata_work_scratch (
        operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fence INTEGER NOT NULL,
        root TEXT NOT NULL UNIQUE, parent TEXT NOT NULL,
        root_created INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('active','ready','stopped','cleaning','cleaned')),
        candidate TEXT);

CREATE TABLE metadata_worker_state(id INTEGER PRIMARY KEY CHECK(id=1),provider_retry_at INTEGER NOT NULL DEFAULT 0);

CREATE TABLE metron_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);

CREATE TABLE metron_pace (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);

CREATE TABLE missing_books (
      id            TEXT PRIMARY KEY,
      series_id     TEXT,
      path          TEXT,
      filename      TEXT,
      issue_number  TEXT,
      cv_issue_id   TEXT,
      file_size     INTEGER,
      row_json      TEXT NOT NULL,
      missing_since TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE missing_series (
      id            TEXT PRIMARY KEY,
      library_id    TEXT,
      path          TEXT,
      name          TEXT,
      year          INTEGER,
      cv_volume_id  TEXT,
      row_json      TEXT NOT NULL,
      missing_since TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE monitored_issues (
    id              TEXT PRIMARY KEY,
    series_id       TEXT NOT NULL,
    issue_number    TEXT NOT NULL,
    title           TEXT,
    release_date    TEXT,
    store_date      TEXT,
    status          TEXT DEFAULT 'wanted',
    file_path       TEXT,
    download_id     TEXT,
    cv_data         TEXT,
    date_added      TEXT DEFAULT (datetime('now')),
    date_processed  TEXT, is_annual INTEGER DEFAULT 0, last_retag_cv_hash TEXT, download_url TEXT, fail_count INTEGER DEFAULT 0, last_fail_reason TEXT, has_comicinfo INTEGER DEFAULT NULL, last_cv_check TEXT, retry_after TEXT, retry_epoch TEXT, weekly_retries INTEGER DEFAULT 0, failed_at TEXT,
    FOREIGN KEY (series_id) REFERENCES monitored_series(id)
  );

CREATE TABLE monitored_series (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    publisher     TEXT,
    year          INTEGER,
    total_issues  INTEGER DEFAULT 0,
    have_issues   INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'active',
    directory     TEXT NOT NULL,
    image_url     TEXT,
    cv_url        TEXT,
    last_cv_check TEXT,
    date_added    TEXT DEFAULT (datetime('now'))
  , series_status TEXT DEFAULT 'unknown', annual_no_match_until TEXT, series_type TEXT DEFAULT 'comic', parent_series_id TEXT DEFAULT NULL, is_special INTEGER DEFAULT 0, source_name TEXT DEFAULT NULL, locg_series_id TEXT DEFAULT NULL, locg_series_slug TEXT DEFAULT NULL, series_json_refreshed_at TEXT, fill_auto_remove INTEGER DEFAULT 0, fill_started_at TEXT, series_status_source TEXT, metron_series_id INTEGER, shelf_home_id TEXT DEFAULT NULL);

CREATE TABLE pack_leftovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pack_id INTEGER NOT NULL, series_id TEXT, file TEXT NOT NULL, name TEXT NOT NULL,
  reason TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'open', issue_id TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE problem_reports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT NOT NULL,
      kind         TEXT NOT NULL,
      target_type  TEXT NOT NULL,
      target_id    TEXT,
      target_label TEXT,
      page_url     TEXT,
      note         TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      admin_note   TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      handled_at   TEXT,
      handled_by   TEXT
    );

CREATE TABLE publisher_config (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher   TEXT NOT NULL,
    use_folder_detection INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

CREATE TABLE publisher_eras (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_id INTEGER NOT NULL REFERENCES publisher_config(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    start_year   INTEGER,
    end_year     INTEGER,
    sort_order   INTEGER DEFAULT 0
  , folder TEXT);

CREATE TABLE publisher_imprints (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_id INTEGER NOT NULL REFERENCES publisher_config(id) ON DELETE CASCADE,
    pattern      TEXT NOT NULL,
    name         TEXT NOT NULL
  );

CREATE TABLE publisher_skip_patterns (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    publisher_id INTEGER NOT NULL REFERENCES publisher_config(id) ON DELETE CASCADE,
    pattern      TEXT NOT NULL
  );

CREATE TABLE pull_preferences(user_id TEXT PRIMARY KEY, favorites_handled INTEGER NOT NULL DEFAULT 0);

CREATE TABLE "read_progress" (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id    TEXT NOT NULL,
        user_id    TEXT,
        page       INTEGER DEFAULT 0,
        completed  INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , marked INTEGER DEFAULT 0, context TEXT);

CREATE TABLE reading_contexts (
    user_id TEXT NOT NULL, ctx TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, min_tier TEXT,
    last_book_id TEXT, updated_at TEXT NOT NULL, dismissed_at TEXT,
    PRIMARY KEY (user_id, ctx));

CREATE TABLE reading_list_entries (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id            INTEGER NOT NULL,
      sort_order         REAL NOT NULL DEFAULT 0,
      entry_type         TEXT NOT NULL,
      ref_id             TEXT,
      cv_volume_id       TEXT,
      scanned_series_id  TEXT,
      issue_start        TEXT,
      issue_end          TEXT,
      label              TEXT,
      note               TEXT,
      unpacked           INTEGER NOT NULL DEFAULT 0,
      resolve_status     TEXT,
      resolve_source     TEXT,
      resolved_at        TEXT,
      created_at         TEXT DEFAULT (datetime('now'))
    , tier_filter TEXT);

CREATE TABLE reading_list_follows (
      user_id      TEXT NOT NULL,
      list_id      INTEGER NOT NULL,
      followed_at  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, list_id)
    );

CREATE TABLE reading_lists (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      description  TEXT,
      owner_id     TEXT NOT NULL,
      visibility   TEXT NOT NULL DEFAULT 'private',
      cover_image  TEXT,
      source       TEXT NOT NULL DEFAULT 'manual',
      copied_from  INTEGER,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    , catalog_json TEXT, home_tagline TEXT, home_description TEXT);

CREATE TABLE reading_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, book_id TEXT NOT NULL,
      finished_at TEXT NOT NULL, local_day TEXT NOT NULL, local_hour INTEGER, pages INTEGER, context TEXT, seconds INTEGER);

CREATE TABLE release_cv_map (
    norm_name      TEXT NOT NULL,
    norm_publisher TEXT NOT NULL DEFAULT '',
    cv_volume_id   TEXT NOT NULL,
    source         TEXT DEFAULT 'auto',
    updated_at     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (norm_name, norm_publisher)
  );

CREATE TABLE revoked_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);

CREATE TABLE scanned_books (
    id                  TEXT PRIMARY KEY,
    series_id           TEXT NOT NULL,
    path                TEXT NOT NULL UNIQUE,
    filename            TEXT NOT NULL,
    issue_number        TEXT,
    title               TEXT,
    comicinfo           TEXT,
    monitored_issue_id  TEXT,
    sort_order          REAL DEFAULT 0,
    last_scanned        DATETIME DEFAULT CURRENT_TIMESTAMP, file_mtime INTEGER DEFAULT 0, file_size INTEGER DEFAULT 0, cv_issue_id TEXT, is_special INTEGER DEFAULT 0, sweep_checked_at TEXT, sweep_result TEXT,
    FOREIGN KEY (series_id) REFERENCES scanned_series(id)
  );

CREATE TABLE scanned_series (
    id                   TEXT PRIMARY KEY,
    library_id           TEXT NOT NULL,
    path                 TEXT NOT NULL UNIQUE,
    name                 TEXT,
    year                 INTEGER,
    metadata_status      TEXT DEFAULT 'none',
    series_json          TEXT,
    monitored_series_id  TEXT,
    book_count           INTEGER DEFAULT 0,
    last_scanned         DATETIME DEFAULT CURRENT_TIMESTAMP, dir_mtime INTEGER DEFAULT 0, dir_file_count INTEGER DEFAULT 0,
    FOREIGN KEY (library_id) REFERENCES libraries(id)
  );

CREATE TABLE series_annual_links (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_series_id  TEXT NOT NULL,
    annual_series_id  TEXT NOT NULL,
    UNIQUE(parent_series_id, annual_series_id),
    FOREIGN KEY (parent_series_id) REFERENCES monitored_series(id),
    FOREIGN KEY (annual_series_id) REFERENCES monitored_series(id)
  );

CREATE TABLE series_annual_volumes (scanned_series_id TEXT NOT NULL, volume_id TEXT NOT NULL, name TEXT, start_year INTEGER,
      source TEXT NOT NULL DEFAULT 'finder', added_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (scanned_series_id, volume_id));

CREATE TABLE series_json_cache (
    series_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE series_link_checks (
      series_id   TEXT PRIMARY KEY,
      comicid     TEXT NOT NULL,          -- series.json's volume when checked
      books       INTEGER,                -- the folder's book count when checked
      status      TEXT NOT NULL,          -- clear | ok | mixed | mismatch | unknown
      volume_id   TEXT,                   -- the files' main volume
      volume_name TEXT,
      groups      TEXT,                   -- JSON: [{ name, books, volumeId, volumeName }]
      checked_at  INTEGER NOT NULL,
      dismissed   INTEGER NOT NULL DEFAULT 0
    );

CREATE TABLE series_link_overrides (
      series_id  TEXT NOT NULL,
      home_id    TEXT NOT NULL DEFAULT '', -- '' for keep_visible (the whole series)
      action     TEXT NOT NULL,            -- reject | keep_visible
      created_at INTEGER NOT NULL,
      PRIMARY KEY (series_id, home_id, action));

CREATE TABLE series_links (
      series_id  TEXT NOT NULL,
      home_id    TEXT NOT NULL,
      source     TEXT NOT NULL,            -- rule | manual
      role       TEXT NOT NULL,            -- tie-in | core | prelude | epilogue | initiative | special
      hidden     INTEGER NOT NULL DEFAULT 0,
      reason     TEXT,
      created_at INTEGER NOT NULL, event_id TEXT,
      PRIMARY KEY (series_id, home_id));

CREATE TABLE series_metadata (
    series_id TEXT PRIMARY KEY,
    custom_description TEXT,
    custom_tags TEXT,
    reading_order INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

CREATE TABLE series_packs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id   TEXT NOT NULL,
    download_id TEXT,
    file_path   TEXT,
    status      TEXT DEFAULT 'snatched',  -- snatched | downloaded | processing | processed | failed
    grabbed_at  TEXT DEFAULT (datetime('now')), fail_reason TEXT, failed_at TEXT, retry_after TEXT,
    FOREIGN KEY (series_id) REFERENCES monitored_series(id)
  );

CREATE TABLE series_ratings (
    series_id   TEXT PRIMARY KEY,
    cbr_score   REAL,
    cbr_count   INTEGER,
    cbr_url     TEXT,
    fetched_at  TEXT
  , user_score REAL, user_count INTEGER);

CREATE TABLE series_types (
    comicid    TEXT PRIMARY KEY,      -- Comic Vine volume ID (series.json comicid)
    metron_id  INTEGER,
    type       TEXT,                  -- Metron's own words, e.g. "Ongoing Series"
    kind       TEXT NOT NULL,         -- ongoing | limited | one-shot | other | unknown
    checked_at INTEGER NOT NULL);

CREATE TABLE series_user_tags (
    series_id  TEXT NOT NULL,
    tag        TEXT NOT NULL,
    created_by TEXT,
    PRIMARY KEY (series_id, tag)
  );

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

CREATE TABLE shelf_sorter_answers (
      kind TEXT NOT NULL, item_id TEXT NOT NULL,
      hash TEXT NOT NULL,              -- what was sent; asked again only when it changes
      model TEXT, answer TEXT NOT NULL, asked_at INTEGER NOT NULL, run_id TEXT,
      applied TEXT,                    -- run id that applied it, 'undone:<run>' or 'user'
      PRIMARY KEY (kind, item_id));

CREATE TABLE shelf_sorter_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      kind TEXT NOT NULL,              -- event | reject | keep_visible
      event_id TEXT, series_id TEXT, home_id TEXT, previous TEXT);

CREATE TABLE shelf_sorter_runs (
      id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER,
      mode TEXT NOT NULL,              -- ask | apply | auto | row
      status TEXT NOT NULL,            -- running | done | failed | stopped
      asked INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0, model TEXT, error TEXT, undone_at INTEGER);

CREATE TABLE summary_import_files (
    file TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, imported_at INTEGER, report TEXT
  );

CREATE TABLE sweep_extra_volumes (
  series_id  TEXT NOT NULL,
  volume_id  TEXT NOT NULL,
  name       TEXT,
  start_year INTEGER,
  publisher  TEXT,
  added_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (series_id, volume_id)
);

CREATE TABLE user_achievements (user_id TEXT NOT NULL, achievement_id TEXT NOT NULL, earned_at TEXT NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, achievement_id));

CREATE TABLE user_appearance (
  user_id    TEXT PRIMARY KEY,
  prefs      TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE user_favorites (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT NOT NULL,
    series_id TEXT NOT NULL,
    added_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, series_id)
  );

CREATE TABLE user_xp_state (
      user_id          TEXT PRIMARY KEY,
      total_xp         INTEGER NOT NULL DEFAULT 0,
      current_streak   INTEGER NOT NULL DEFAULT 0,
      longest_streak   INTEGER NOT NULL DEFAULT 0,
      last_active_date TEXT,                          -- 'YYYY-MM-DD' user-local
      shields          INTEGER NOT NULL DEFAULT 0,    -- banked streak shields
      rank_id          TEXT NOT NULL DEFAULT 'rookie',
      rank_title       TEXT,                          -- user-chosen title; null = rank default
      updated_at       TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    email        TEXT UNIQUE,
    password_hash TEXT,
    role         TEXT NOT NULL DEFAULT 'user',
    authentik_id TEXT UNIQUE,
    created_at   TEXT DEFAULT (datetime('now')),
    last_login   TEXT
  , auth_version INTEGER NOT NULL DEFAULT 1);

CREATE TABLE xp_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT    NOT NULL,
      book_id      TEXT,
      kind         TEXT    NOT NULL,                  -- 'page'|'completion'|'first_contact'|'streak_milestone'|'admin_adjust'
      pages        INTEGER NOT NULL DEFAULT 0,
      xp           INTEGER NOT NULL,
      occurred_at  TEXT    DEFAULT (datetime('now')),
      local_date   TEXT    NOT NULL                   -- 'YYYY-MM-DD' in user-local tz
    );

CREATE INDEX ai_calls_at ON ai_calls(at);

CREATE INDEX ai_calls_request ON ai_calls(request_id);

CREATE INDEX ai_calls_run ON ai_calls(run_id);

CREATE INDEX ai_jobs_at ON ai_jobs(at);

CREATE INDEX bl_issue ON download_blacklist(issue_id);

CREATE INDEX cv_api_log_res_ts ON cv_api_log(resource, ts);

CREATE INDEX idx_ai_usage_user_day ON ai_usage(user_id, day);

CREATE INDEX idx_assistant_phrases_user ON assistant_phrases(user_id, id);

CREATE INDEX idx_book_ci_name ON book_ci_index(name_key, orig_number);

CREATE INDEX idx_cms_box ON collection_missing_series(collection_id);

CREATE INDEX idx_cms_pending ON collection_missing_series(cv_checked_at);

CREATE INDEX idx_collection_follows_box ON collection_follows(collection_id);

CREATE INDEX idx_dlreq_issue  ON download_requests(list_issue_id, user_id);

CREATE INDEX idx_dlreq_source ON download_requests(kind, source_issue_id, user_id);

CREATE INDEX idx_dlreq_status ON download_requests(status);

CREATE INDEX idx_identity_rebinds_time ON identity_rebinds(created_at);

CREATE INDEX idx_li_book ON list_issues(scanned_book_id);

CREATE INDEX idx_li_owner ON list_issues(owner_kind, owner_id, sort_order);

CREATE INDEX idx_missing_books_cv ON missing_books(cv_issue_id);

CREATE INDEX idx_missing_books_series ON missing_books(series_id);

CREATE INDEX idx_missing_series_cv ON missing_series(cv_volume_id);

CREATE INDEX idx_reading_log_book ON reading_log(book_id, local_day);

CREATE INDEX idx_reading_log_user ON reading_log(user_id, local_day);

CREATE INDEX idx_reports_status ON problem_reports(status);

CREATE INDEX idx_reports_user   ON problem_reports(user_id);

CREATE INDEX idx_rl_owner ON reading_lists(owner_id);

CREATE INDEX idx_rl_visibility ON reading_lists(visibility);

CREATE INDEX idx_rle_list ON reading_list_entries(list_id, sort_order);

CREATE INDEX idx_scanned_books_cv ON scanned_books(cv_issue_id);

CREATE INDEX idx_scanned_books_monitored ON scanned_books(monitored_issue_id);

CREATE INDEX idx_scanned_books_series ON scanned_books(series_id);

CREATE INDEX metadata_jobs_due ON metadata_jobs(due_at,group_key,kind);

CREATE INDEX metadata_work_resource_owner ON metadata_work_resources(operation_id);

CREATE UNIQUE INDEX one_pull_box_per_user ON collections(owner_id) WHERE purpose='pull';

CREATE INDEX pack_leftovers_pack ON pack_leftovers(pack_id, status);

CREATE UNIQUE INDEX rp_user_book ON read_progress(user_id, book_id);

CREATE INDEX series_links_home ON series_links(home_id);

CREATE INDEX shelf_sorter_changes_run ON shelf_sorter_changes(run_id);

CREATE INDEX xp_events_user_date ON xp_events(user_id, local_date);

CREATE INDEX xp_events_user_occ  ON xp_events(user_id, occurred_at);

CREATE TRIGGER box_artwork_delete_collection AFTER DELETE ON collections BEGIN DELETE FROM box_artwork_preferences WHERE kind='collection' AND box_id=CAST(OLD.id AS TEXT); END;

CREATE TRIGGER box_artwork_delete_order AFTER DELETE ON reading_lists BEGIN DELETE FROM box_artwork_preferences WHERE kind='order' AND box_id=CAST(OLD.id AS TEXT); END;

CREATE TRIGGER mi_failed_at AFTER UPDATE OF status ON monitored_issues
           WHEN NEW.status = 'failed' AND (OLD.status IS NULL OR OLD.status != 'failed')
           BEGIN UPDATE monitored_issues SET failed_at = datetime('now') WHERE id = NEW.id; END;
