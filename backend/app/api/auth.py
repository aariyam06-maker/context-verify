from __future__ import annotations

from fastapi import APIRouter, Cookie, HTTPException, Request, Response, status
from sqlalchemy import select

from ..auth import create_access_token, hash_password, issue_refresh_session, revoke_refresh, rotate_refresh, verify_password
from ..config import settings
from ..db import SessionLocal
from ..models import User
from ..schemas import LoginRequest, RegisterRequest, TokenResponse, UserOut

router = APIRouter(prefix="/auth", tags=["authentication"])
REFRESH_COOKIE = "ctx_refresh"
_ATTEMPTS: dict[str, list[float]] = {}

def _rate_limit(request: Request, bucket: str, limit: int = 20, window: int = 60) -> None:
    import time
    key = f"{request.client.host if request.client else 'unknown'}:{bucket}"
    now = time.time()
    values = [t for t in _ATTEMPTS.get(key, []) if now - t < window]
    if len(values) >= limit:
        raise HTTPException(429, "Too many authentication attempts. Try again later.")
    values.append(now)
    _ATTEMPTS[key] = values


DEMO_ACCOUNTS = [
    {"email": "demo@contexttrace.app", "password": "DemoTrace@2026", "role": "user", "label": "Demo analyst"},
    {"email": "admin@contexttrace.app", "password": "AdminTrace@2026", "role": "admin", "label": "Demo admin"},
]


def demo_enabled() -> bool:
    import os
    return os.getenv("CTXTRACE_DEMO", "true").lower() == "true"


def seed_demo_accounts() -> None:
    """Create the demo accounts (idempotent). Disable with CTXTRACE_DEMO=false."""
    if not demo_enabled():
        return
    db = SessionLocal()
    try:
        for acc in DEMO_ACCOUNTS:
            user = db.scalar(select(User).where(User.email == acc["email"]))
            if not user:
                db.add(User(email=acc["email"], password_hash=hash_password(acc["password"]), role=acc["role"]))
            elif user.role != acc["role"]:
                user.role = acc["role"]
        db.commit()
    finally:
        db.close()


@router.get("/demo")
def demo_accounts():
    """Public list of demo credentials so the login page can offer one-click sign-in."""
    if not demo_enabled():
        return {"enabled": False, "accounts": []}
    return {"enabled": True, "accounts": [{k: a[k] for k in ("email", "password", "label", "role")} for a in DEMO_ACCOUNTS]}


def _set_refresh_cookie(response: Response, raw: str) -> None:
    response.set_cookie(REFRESH_COOKIE, raw, httponly=True, secure=settings.cookie_secure, samesite="lax", max_age=settings.refresh_token_days * 86400, path="/api/auth")


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path="/api/auth")


@router.post("/register", response_model=TokenResponse)
def register(request: Request, payload: RegisterRequest, response: Response):
    _rate_limit(request, "register")
    db = SessionLocal()
    try:
        email = payload.email.lower().strip()
        if db.scalar(select(User).where(User.email == email)):
            raise HTTPException(409, "An account with this email already exists.")
        user = User(email=email, password_hash=hash_password(payload.password), role="user")
        db.add(user); db.commit(); db.refresh(user)
        refresh = issue_refresh_session(db, user)
        _set_refresh_cookie(response, refresh)
        return TokenResponse(access_token=create_access_token(user), user=UserOut.model_validate(user))
    finally:
        db.close()


@router.post("/guest", response_model=TokenResponse)
def guest_login(request: Request, response: Response):
    _rate_limit(request, "register")
    import secrets
    db = SessionLocal()
    try:
        suffix = secrets.token_hex(6)
        email = f"guest-{suffix}@trial.contexttrace.local"
        password = secrets.token_urlsafe(18)
        if db.scalar(select(User).where(User.email == email)):
            return guest_login(request, response)
        user = User(email=email, password_hash=hash_password(password), role="user")
        db.add(user); db.commit(); db.refresh(user)
        refresh = issue_refresh_session(db, user)
        _set_refresh_cookie(response, refresh)
        return TokenResponse(access_token=create_access_token(user), user=UserOut.model_validate(user))
    finally:
        db.close()


@router.post("/login", response_model=TokenResponse)
def login(request: Request, payload: LoginRequest, response: Response):
    _rate_limit(request, "login")
    db = SessionLocal()
    try:
        user = db.scalar(select(User).where(User.email == payload.email.lower().strip()))
        if not user or not verify_password(payload.password, user.password_hash):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password.")
        if not user.password_hash.startswith("$argon2"):
            user.password_hash = hash_password(payload.password)
            db.commit()
        refresh = issue_refresh_session(db, user)
        _set_refresh_cookie(response, refresh)
        return TokenResponse(access_token=create_access_token(user), user=UserOut.model_validate(user))
    finally:
        db.close()


@router.post("/refresh", response_model=TokenResponse)
def refresh(response: Response, ctx_refresh: str | None = Cookie(default=None)):
    rotated = rotate_refresh(ctx_refresh)
    if not rotated:
        _clear_refresh_cookie(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh session expired or revoked.")
    raw, user = rotated
    _set_refresh_cookie(response, raw)
    return TokenResponse(access_token=create_access_token(user), user=UserOut.model_validate(user))


@router.post("/logout")
def logout(response: Response, ctx_refresh: str | None = Cookie(default=None)):
    revoke_refresh(ctx_refresh)
    _clear_refresh_cookie(response)
    return {"ok": True}
