# @erwisnu/opencode-kiro-auth

Plugin OpenCode untuk Kiro AI yang menambahkan provider `kiro`, sinkronisasi akun dari Kiro CLI/AWS SSO, rotasi multi-akun, quota tracking, dan command operasional.

## Model Yang Didukung

Plugin ini hanya mengekspos model free-tier Kiro:

- `claude-sonnet-4-5`
- `claude-haiku-4-5`

## Install Di OpenCode

Install package dari npm:

```bash
npm install @erwisnu/opencode-kiro-auth
```

Lalu tambahkan plugin ke konfigurasi OpenCode Anda.

Contoh `opencode.json`:

```json
{
  "plugin": ["@erwisnu/opencode-kiro-auth"]
}
```

Jika OpenCode Anda memakai file config lain, tambahkan package ini ke array `plugin` pada config yang aktif.

## Konfigurasi Plugin

Plugin membaca config dari:

- default: `~/.config/opencode/kiro.config.json`
- override via env: `KIRO_AUTH_CONFIG_PATH`

Contoh `kiro.config.json`:

```json
{
  "auto_sync_kiro_cli": true,
  "auto_sync_aws_sso": true,
  "account_selection_strategy": "lowest-usage",
  "default_region": "us-east-1",
  "rate_limit_retry_delay_ms": 5000,
  "rate_limit_max_retries": 3,
  "usage_tracking_enabled": true,
  "low_quota_threshold_credits": 15,
  "sync_interval_ms": 60000
}
```

Opsi penting:

- `auto_sync_kiro_cli`: scan cache/session lokal Kiro
- `auto_sync_aws_sso`: scan `~/.aws/sso/cache`
- `account_selection_strategy`: `lowest-usage`, `round-robin`, atau `sticky`
- `default_region`: default AWS region
- `rate_limit_retry_delay_ms`: base delay untuk exponential backoff
- `rate_limit_max_retries`: jumlah retry/failover
- `usage_tracking_enabled`: aktifkan tracking usage dari event OpenCode

## Cara Kerja Auth

Plugin memakai strategi `reference-only`:

- database hanya menyimpan metadata akun, fingerprint token, expiry, dan pointer ke source credential
- token mentah tidak disimpan di SQLite
- source yang didukung:
  - AWS SSO cache
  - Kiro CLI JSON/cache DB bila tersedia
  - import manual via file JSON atau env var

Default transport Kiro mengikuti AWS CodeWhisperer endpoint yang dipakai Kiro:

- `POST https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse`
- `Accept: application/vnd.amazon.eventstream`
- `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`

Refresh token:

- social auth: `https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken`
- Builder ID / IDC: AWS SSO OIDC token endpoint

## Commands Yang Tersedia

Plugin mendaftarkan command/tool berikut:

- `kiro:accounts`
- `kiro:quota`
- `kiro:sync`
- `kiro:add`
- `kiro:switch`

Fungsi ringkasnya:

- `kiro:accounts`: list akun, health, expiry, dan status routing
- `kiro:quota`: tampilkan credits/quota dan usage estimasi
- `kiro:sync`: paksa sinkronisasi dari Kiro CLI/AWS SSO
- `kiro:add`: import akun manual
- `kiro:switch`: override akun aktif

## Development

Install dependency:

```bash
npm install
```

Validasi:

```bash
npm run check
npm test
npm run build
```

Preview isi paket npm:

```bash
npm pack --dry-run
```

## Publish Ke npm

Package ini ditujukan untuk publish sebagai:

```text
@erwisnu/opencode-kiro-auth
```

Publish manual:

```bash
npm publish --access public
```

Atau publish via GitHub Actions:

1. set secret `NPM_TOKEN`
2. push commit
3. buat tag versi:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Workflow publish akan:

- install dependency
- jalankan `check`, `test`, `build`
- verifikasi tag cocok dengan `package.json`
- jalankan `npm publish --access public`
