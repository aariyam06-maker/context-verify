from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)


class LoginRequest(RegisterRequest):
    pass


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    role: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    user: UserOut


class JobSummary(BaseModel):
    _id: str
    mode: str
    status: str
    currentStage: str | None
    progress: int
    createdAt: int
    completedAt: int | None
    startedAt: int | None = None
    errorMessage: str | None
    warnings: list[str]
    sourceFilename: str
    editedFilename: str
    sourceVideoKey: str | None
    editedVideoKey: str | None
    report: dict[str, Any] | None


class JobDetail(JobSummary):
    sourceVideo: dict[str, Any] | None
    editedVideo: dict[str, Any] | None
    pipelineVersion: str
    modelConfiguration: str


class ReportOut(BaseModel):
    _id: str
    jobId: str
    score: int
    overallConfidence: float
    evidenceCoverage: float
    uncertainty: float
    interpretation: str
    pipelineVersion: str
    modelConfiguration: str
    degraded: bool
    eventCount: int
    createdAt: int
    findings: list[dict[str, Any]]
    scanResult: dict[str, Any] | None = None
    mitigation: dict[str, Any] | None = None
    visualEvidence: list[dict[str, Any]] = []
    sourceOcr: list[dict[str, Any]] = []
    editedOcr: list[dict[str, Any]] = []

