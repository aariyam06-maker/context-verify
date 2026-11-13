#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass

from backend.app.auth import hash_password
from backend.app.db import SessionLocal
from backend.app.models import User


def main() -> None:
    p = argparse.ArgumentParser(description="Provision a ContextTrace administrator; registration can never create admins.")
    p.add_argument("email")
    args = p.parse_args()
    password = getpass.getpass("Admin password (10+ chars): ")
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == args.email.lower().strip()).first()
        if user is None:
            user = User(email=args.email.lower().strip(), password_hash=hash_password(password), role="admin")
            db.add(user)
        else:
            user.role = "admin"
            user.password_hash = hash_password(password)
        db.commit()
        print(f"Admin provisioned: {user.email}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
