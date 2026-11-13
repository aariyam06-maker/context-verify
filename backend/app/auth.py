from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerifyMismatchError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import SessionLocal
from .models import AuthSession, User

ALGORITHM = "HS256"
security = HTTPBearer(auto_error=False)
_password_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2, hash_len=32, salt_len=16)


def hash_password(password: str) -> str:
    if len(password) < 10:
        raise ValueError("Password must be at least 10 characters.")
    return _password_hasher.hash(password)


def verify_password(password: str, encoded: str) -> bool:
    if encoded.startswith("$argon2"):
        try:
            return _password_hasher.verify(encoded, password)
        except (VerifyMismatchError, InvalidHash):
            return False
    # Backward-compatible verification for v3 accounts; callers may rehash on
    # successful login when needs_rehash() reports true.
    try:
        scheme, rounds, salt_hex, digest_hex = encoded.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds))
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


def create_access_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": user.id, "email": user.email, "role": user.role, "typ": "access", "iat": now, "exp": now + timedelta(minutes=settings.access_token_minutes)}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def issue_refresh_session(db: Session, user: User) -> str:
    raw = secrets.token_urlsafe(64)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    row = AuthSession(user_id=user.id, refresh_token_hash=digest, expires_at=datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_days))
    db.add(row)
    db.commit()
    return raw


def revoke_refresh(raw: str | None) -> None:
    if not raw:
        return
    digest = hashlib.sha256(raw.encode()).hexdigest()
    db = SessionLocal()
    try:
        row = db.scalar(select(AuthSession).where(AuthSession.refresh_token_hash == digest))
        if row and not row.revoked_at:
            row.revoked_at = datetime.now(timezone.utc)
            db.commit()
    finally:
        db.close()


def rotate_refresh(raw: str | None) -> tuple[str, User] | None:
    if not raw:
        return None
    digest = hashlib.sha256(raw.encode()).hexdigest()
    db = SessionLocal()
    try:
        row = db.scalar(select(AuthSession).where(AuthSession.refresh_token_hash == digest))
        if not row:
            return None
        now = datetime.now(timezone.utc)
        expires = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
        if row.revoked_at or expires <= now:
            return None
        user = db.get(User, row.user_id)
        if not user:
            return None
        row.revoked_at = now
        new_raw = secrets.token_urlsafe(64)
        db.add(AuthSession(user_id=user.id, refresh_token_hash=hashlib.sha256(new_raw.encode()).hexdigest(), expires_at=now + timedelta(days=settings.refresh_token_days)))
        db.commit()
        return new_raw, user
    finally:
        db.close()


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> User:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    try:
        payload = jwt.decode(credentials.credentials, settings.secret_key, algorithms=[ALGORITHM])
        if payload.get("typ") != "access":
            raise ValueError("Wrong token type")
        user_id = str(payload["sub"])
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired access token.")
    db: Session = SessionLocal()
    try:
        user = db.get(User, user_id)
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found.")
        return user
    finally:
        db.close()


def admin_user(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator role required.")
    return user
