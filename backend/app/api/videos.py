from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..auth import current_user
from ..config import settings
from ..db import SessionLocal
from ..models import Video
from ..services.media import probe_media, validate_extension
from fastapi import Depends
from fastapi.responses import FileResponse
from ..models import User

router = APIRouter(prefix="/videos", tags=["videos"])


@router.post("/upload")
async def upload_video(file: UploadFile = File(...), type: str = Form("detect"), user: User = Depends(current_user)):
    if type not in {"detect", "a", "b"}:
        raise HTTPException(400, "Video type must be detect, a or b.")
    try:
        validate_extension(file.filename or "video.mp4")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    suffix = Path(file.filename or "video.mp4").suffix.lower()
    video_id = str(uuid.uuid4())
    path = settings.upload_dir / user.id / f"{video_id}{suffix}"
    path.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with path.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_mb * 1024 * 1024:
                    raise HTTPException(413, f"File exceeds the {settings.max_upload_mb} MB limit.")
                out.write(chunk)
        # Decoder/probe work must not block the API event loop.
        from starlette.concurrency import run_in_threadpool
        meta = await run_in_threadpool(probe_media, path)
    except BaseException as exc:
        # Close the writer before unlinking (required on Windows).
        path.unlink(missing_ok=True)
        if isinstance(exc, HTTPException):
            raise
        if not isinstance(exc, Exception):
            raise
        raise HTTPException(400, f"Media validation failed: {exc}") from exc
    finally:
        await file.close()

    db = SessionLocal()
    try:
        video = Video(id=video_id, owner_id=user.id, type=type, filename=file.filename or path.name, mime_type=file.content_type or "video/*", byte_size=size, storage_path=str(path), duration_seconds=meta["duration"], width=meta["width"], height=meta["height"], has_audio=meta["has_audio"], validation_status="uploaded")
        db.add(video); db.commit()
        return {"ok": True, "videoId": video.id, "filename": video.filename, "durationSeconds": video.duration_seconds, "width": video.width, "height": video.height, "hasAudio": video.has_audio, "storageKey": video.id}
    finally:
        db.close()


@router.get("/{video_id}")
def get_video(video_id: str, user: User = Depends(current_user)):
    db = SessionLocal()
    try:
        video = db.get(Video, video_id)
        if not video or video.owner_id != user.id:
            raise HTTPException(404, "Video not found.")
        return {"_id": video.id, "filename": video.filename, "mimeType": video.mime_type, "byteSize": video.byte_size, "durationSeconds": video.duration_seconds, "width": video.width, "height": video.height, "hasAudio": video.has_audio, "storageKey": video.id}
    finally:
        db.close()


@router.get("/{video_id}/stream")
def stream_video(video_id: str, user: User = Depends(current_user)):
    db = SessionLocal()
    try:
        video = db.get(Video, video_id)
        if not video or video.owner_id != user.id:
            raise HTTPException(404, "Video not found.")
        path = Path(video.storage_path)
        if not path.exists():
            raise HTTPException(404, "Video artifact is missing from storage.")
        return FileResponse(path, media_type=video.mime_type, filename=video.filename, content_disposition_type="inline")
    finally:
        db.close()
