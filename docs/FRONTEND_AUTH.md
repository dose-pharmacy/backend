# Frontend authentication contract

The frontend talks to Better Auth over HTTP. It does not need Better Auth internals beyond the routes, cookies, and CORS rules below.

Base URLs:

- Auth: `{API_ORIGIN}/api/auth`
- Application API: `{API_ORIGIN}/api/v1`

Use the official Better Auth client (`better-auth/client`) against `{API_ORIGIN}/api/auth`.

## Cookies and credentials

Sessions are cookie-based (`better-auth.session_token`).

- Cookies are `HttpOnly`. JavaScript cannot read the session token.
- Do not store role, session, or auth tokens in frontend-only state as the source of truth.
- Every authenticated request must send cookies.

Browser `fetch` / Axios:

```ts
credentials: "include"
```

CORS:

- The API allows only configured origins (`FRONTEND_URL` and optional `CORS_ORIGINS`).
- `Access-Control-Allow-Credentials` is enabled.
- Production does **not** use `origin: "*"`.

### Development

- API example: `http://localhost:4000`
- Frontend example: `http://localhost:5173`
- Cookies: `Secure=false`, `SameSite=Lax` (same-site localhost HTTP)

### Production

- Use HTTPS for both API and frontend.
- Cookies: `Secure=true`, `SameSite=None` so a separate frontend origin can send them.
- Set `BETTER_AUTH_URL` to the public API origin (this builds the Google callback URL).
- Set `FRONTEND_URL` to the public frontend origin.

## Registration (email + password)

`POST /api/auth/sign-up/email`

JSON body:

```json
{
  "name": "Ada Lovelace",
  "email": "ada@example.com",
  "password": "at-least-8-characters"
}
```

- Password length: 8–128 characters.
- Password hashing is handled by Better Auth. Do not hash on the frontend.
- A session cookie is set on success (`autoSignIn`).
- Duplicate email returns a 4xx error from Better Auth.

Better Auth client:

```ts
await authClient.signUp.email({ name, email, password });
```

## Login

`POST /api/auth/sign-in/email`

```json
{
  "email": "ada@example.com",
  "password": "at-least-8-characters"
}
```

Invalid credentials and unknown users return 4xx. Do not distinguish those cases in UI copy beyond a generic failure.

```ts
await authClient.signIn.email({ email, password });
```

## Logout

`POST /api/auth/sign-out`

Must include the session cookie. After logout, `GET /api/auth/get-session` is `null`.

```ts
await authClient.signOut();
```

## Session check

`GET /api/auth/get-session`

- Authenticated: JSON with `user` and `session` (no password, no raw session token for you to persist).
- Unauthenticated: `null` with HTTP 200.

This is the supported equivalent of “is the user logged in?”. Use it on app load and after OAuth redirect.

```ts
const session = await authClient.getSession();
```

`user.role` is included for display only. Authorization is enforced on the server from the database.

## Google OAuth

1. Frontend starts Google sign-in:

```ts
await authClient.signIn.social({
  provider: "google",
  callbackURL: window.location.origin,
});
```

2. Browser redirects to Google, then back to:

`{BETTER_AUTH_URL}/api/auth/callback/google`

3. Better Auth creates or reuses the user, sets the session cookie, and redirects to `callbackURL`.

Google Cloud Console authorized redirect URI must match:

- Development: `http://localhost:4000/api/auth/callback/google`
- Production: `https://<api-host>/api/auth/callback/google`

Existing Google users are signed in; new users are created with the application default role (`ADMIN` in this phase).

## Protected API requests

Example:

`GET /api/v1/admin/test`

```ts
await fetch(`${API_ORIGIN}/api/v1/admin/test`, {
  credentials: "include",
});
```

Send cookies. Do not send a role header or a client-supplied user id for authorization.

## HTTP error handling

Application JSON errors look like:

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Authentication required"
  }
}
```

| Status | Meaning | Frontend action |
| --- | --- | --- |
| 401 | No valid session | Clear local auth UI state, redirect to login |
| 403 | Authenticated but not allowed | Show “not authorized”; do not treat as logged out |
| 409 | Conflict (e.g. duplicate) | Show field error |
| 422 | Validation | Show field errors |
| 429 | Rate limited | Retry later |
| 500 | Server error | Generic error; never show stack traces |

Better Auth’s own `/api/auth/*` responses use Better Auth’s JSON shape. Handle `error` from the Better Auth client.

## CSRF

Cookie sessions use Better Auth’s built-in CSRF protections for state-changing auth requests. Keep `trustedOrigins` / `FRONTEND_URL` aligned with the real frontend origin. Do not disable credentials or open CORS to `*`.

## What not to do

- Do not implement custom password hashing.
- Do not put `ADMIN` checks only in the UI.
- Do not send `role` from the client as an authorization claim.
- Do not log passwords, cookies, or tokens.
