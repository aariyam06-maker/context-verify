# ContextTrace security baseline

- Passwords use Argon2id; successful legacy PBKDF2 logins are transparently rehashed.
- Access JWTs are held in application memory; they are not persisted to localStorage.
- Refresh tokens are opaque, hashed server-side, rotated on every refresh, and stored in an HttpOnly cookie.
- Logout revokes the current refresh session.
- Registration cannot create administrator accounts.
- Authentication endpoints have per-instance rate limiting; production deployments should also enforce edge/WAF rate limits.
- Protected video, job and report routes enforce owner checks server-side.
- CORS origins are explicit and configurable.
- Production deployments should set `CTXTRACE_COOKIE_SECURE=true`, a random `CTXTRACE_SECRET_KEY`, HTTPS, PostgreSQL, and `CTXTRACE_AUTO_CREATE_DB=false`.
- Uploaded media is stored under UUID-based server paths rather than user-provided filenames.
- Critical analysis failures produce `FAILED` jobs rather than complete-looking reports.
