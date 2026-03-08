# OpenCode Kiro Auth Plugin

Plugin OpenCode berbasis Bun untuk sinkronisasi auth Kiro, rotasi multi-akun, tracking quota, dan tooling operasional.

## Fitur

- Multi-account dari Kiro CLI, AWS SSO cache, dan import manual JSON
- Strategi pemilihan akun `lowest-usage`, `round-robin`, dan `sticky`
- SQLite storage tanpa menyimpan token mentah
- Header injection dinamis untuk provider `kiro`
- Tracking usage dari event `message.updated`
- Tools operasional: `kiro_accounts`, `kiro_quota`, `kiro_sync`, `kiro_add`, `kiro_switch`

## Catatan

- Plugin ini memakai strategi `reference-only`: database hanya menyimpan metadata session dan pointer ke sumber credential.
- Default transport mengikuti proxy Kiro di OmniRoute:
  - `POST https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse`
  - `Accept: application/vnd.amazon.eventstream`
  - `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`
- Refresh token social login memakai `https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken`, sedangkan Builder ID/IDC memakai AWS SSO OIDC token endpoint.
