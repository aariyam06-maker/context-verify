# ContextTrace API

Base URL: `http://localhost:8000/api`

## Authentication

- `POST /auth/register` — `{email,password}` -> bearer token + user.
- `POST /auth/login` — `{email,password}` -> bearer token + user.

Send `Authorization: Bearer <token>` to protected endpoints.

## Media

- `POST /videos/upload` — multipart `file` + `type=source|edited|scan`.
- `GET /videos/{video_id}` — owned metadata.
- `GET /videos/{video_id}/stream` — authenticated media stream for report playback.

## Jobs

- `POST /jobs/compare?sourceVideoId=...&editedVideoId=...` — create asynchronous comparison.
- `POST /jobs/scan?sourceVideoId=...` — create single-video scan job.
- `GET /jobs` — current user's history.
- `GET /jobs/{job_id}` — status/detail.
- `GET /jobs/{job_id}/report` — report + findings.
- `GET /jobs/{job_id}/evidence` — transcripts + alignment mappings.
- `POST /jobs/{job_id}/retry` — retry a failed comparison.
- `POST /jobs/{job_id}/scan-finalize` — persist browser scan result.
- `POST /jobs/{job_id}/mitigation-finalize` — persist mitigation metadata.

## Administration

- `GET /admin/overview` — role-protected review/admin overview.

## Health

- `GET /health` — service and database status.
