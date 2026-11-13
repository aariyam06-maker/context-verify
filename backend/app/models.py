from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from .db import Base, utcnow


def uid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(32), default="user")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    videos = relationship("Video", back_populates="owner", cascade="all, delete-orphan")
    jobs = relationship("AnalysisJob", back_populates="owner", cascade="all, delete-orphan")


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    refresh_token_hash: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user = relationship("User")


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(16))
    filename: Mapped[str] = mapped_column(String(512))
    mime_type: Mapped[str] = mapped_column(String(128))
    byte_size: Mapped[int] = mapped_column(Integer)
    storage_path: Mapped[str] = mapped_column(String(1024))
    duration_seconds: Mapped[float] = mapped_column(Float, default=0)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    has_audio: Mapped[bool] = mapped_column(Boolean, default=False)
    validation_status: Mapped[str] = mapped_column(String(24), default="uploaded")
    validation_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    owner = relationship("User", back_populates="videos")


class AnalysisJob(Base):
    __tablename__ = "analysis_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    source_video_id: Mapped[str | None] = mapped_column(ForeignKey("videos.id"), nullable=True)
    edited_video_id: Mapped[str | None] = mapped_column(ForeignKey("videos.id"), nullable=True)
    mode: Mapped[str] = mapped_column(String(20), default="compare")
    status: Mapped[str] = mapped_column(String(16), default="QUEUED", index=True)
    current_stage: Mapped[str | None] = mapped_column(String(64), nullable=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    pipeline_version: Mapped[str] = mapped_column(String(128))
    model_configuration: Mapped[str] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    owner = relationship("User", back_populates="jobs")


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.id", ondelete="CASCADE"), index=True)
    video_id: Mapped[str] = mapped_column(ForeignKey("videos.id", ondelete="CASCADE"), index=True)
    index: Mapped[int] = mapped_column(Integer)
    start_time: Mapped[float] = mapped_column(Float)
    end_time: Mapped[float] = mapped_column(Float)
    text: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float] = mapped_column(Float)


class AlignmentMapping(Base):
    __tablename__ = "alignment_mappings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.id", ondelete="CASCADE"), index=True)
    source_index: Mapped[int] = mapped_column(Integer)
    edited_index: Mapped[int] = mapped_column(Integer)
    similarity: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float)
    method: Mapped[str] = mapped_column(String(64))


class EvidenceEvent(Base):
    __tablename__ = "evidence_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.id", ondelete="CASCADE"), index=True)
    category: Mapped[str] = mapped_column(String(64))
    severity: Mapped[str] = mapped_column(String(16))
    confidence: Mapped[float] = mapped_column(Float)
    source_start: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_end: Mapped[float | None] = mapped_column(Float, nullable=True)
    edited_start: Mapped[float | None] = mapped_column(Float, nullable=True)
    edited_end: Mapped[float | None] = mapped_column(Float, nullable=True)
    evidence_type: Mapped[str] = mapped_column(String(64))
    explanation: Mapped[str] = mapped_column(Text)
    observed_change: Mapped[str] = mapped_column(Text)
    contextual_impact: Mapped[str] = mapped_column(Text)
    source_segment_ids: Mapped[list] = mapped_column(JSON, default=list)
    edited_segment_ids: Mapped[list] = mapped_column(JSON, default=list)


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(ForeignKey("analysis_jobs.id", ondelete="CASCADE"), unique=True, index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    score: Mapped[int] = mapped_column(Integer)
    overall_confidence: Mapped[float] = mapped_column(Float)
    evidence_coverage: Mapped[float] = mapped_column(Float)
    uncertainty: Mapped[float] = mapped_column(Float)
    interpretation: Mapped[str] = mapped_column(Text)
    pipeline_version: Mapped[str] = mapped_column(String(128))
    model_configuration: Mapped[str] = mapped_column(Text)
    degraded: Mapped[bool] = mapped_column(Boolean, default=False)
    event_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    report_json: Mapped[dict] = mapped_column(JSON, default=dict)
