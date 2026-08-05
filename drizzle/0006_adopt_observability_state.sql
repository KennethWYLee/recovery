UPDATE ops_runtime_schema_state
SET schema_version = '0005',
    schema_digest = 'd375830a0de59dec1d0a29a4ec5b0356e636b72e458ffb0bb888de57225059a3',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE singleton = 1
  AND schema_version = '0004'
  AND schema_digest = 'f1bd7d9267db8475f85b17336b125c77f08d9337e51832af4728daa0f08125a3'
  AND phase = 3
  AND status = 'ready'
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'ops_request_telemetry'
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'index' AND name = 'ops_request_telemetry_time_idx'
  )
  AND EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE type = 'index' AND name = 'ops_request_telemetry_status_time_idx'
  );
