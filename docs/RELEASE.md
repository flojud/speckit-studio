# Releasing speckit studio

## Automatic releases (GitHub Actions)

Development happens on `devel`. Every push to `main` (usually a fast-forward from `devel`) that passes **CI** (`.github/workflows/ci.yml`) triggers **Release** (`.github/workflows/release.yml`):

1. The version is `<major>.<minor>` from `package.json` plus the workflow run number, e.g. `0.1.17`. To start a new line, bump `version` in `package.json` (e.g. to `0.2.0`).
2. macOS (DMG + ZIP, arm64 and x64), Windows (NSIS installer) and Linux (AppImage) are built on their own runners.
3. A GitHub release `v<version>` is created with all files and generated release notes, and becomes "latest".

The file names carry no version (`artifactName` in `electron-builder.yml`), so the README links to `releases/latest/download/<file>` always point at the newest build. The release can also be started by hand (*Actions → Release → Run workflow*).

## Local, unsigned

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack      # dist/mac-arm64/speckit studio.app
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac  # DMG + ZIP for arm64 and x64
```

Unsigned builds run locally; on other Macs Gatekeeper blocks them (`xattr -cr "/Applications/speckit studio.app"`).

## Signing and notarization (not set up yet)

The CI builds are unsigned. To sign macOS builds:

1. A **Developer ID Application** certificate, exported as `.p12`, as repository secrets `CSC_LINK` (base64) and `CSC_KEY_PASSWORD`.
2. Notarization via App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or Apple ID (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) as secrets.
3. In `release.yml`, pass these secrets as `env` to the *Package* step and drop `CSC_IDENTITY_AUTO_DISCOVERY: false`.

Hardened runtime and entitlements are configured in `electron-builder.yml` / `build/entitlements.mac.plist`. Never commit certificates or keys.

## Auto-update (not enabled)

`electron-updater` checks for updates on start of packaged builds, but only once a publish target exists in `electron-builder.yml`:

```yaml
publish:
  provider: github
  owner: flojud
  repo: speckit-studio
```

The release workflow would then also have to upload the `latest*.yml` files. On macOS, updates only work for signed builds.
