# Requirements: TrustTunnel

**Defined:** 2026-04-10
**Core Value:** Reliable VPN connection with full server control from a single desktop app

## v2.5.0 Requirements

Requirements for milestone v2.5.0. Each maps to roadmap phases.

### Connectivity

- [ ] **CONN-01**: Приложение определяет IP физического адаптера (Ethernet/WiFi), исключая VPN/WinTUN
- [ ] **CONN-02**: TCP-проверки связи привязываются к физическому адаптеру через socket2 bind()
- [ ] **CONN-03**: HTTP-проверки используют reqwest с local_address(physical_ip)
- [ ] **CONN-04**: При отсутствии физического адаптера — fallback на дефолтную маршрутизацию
- [ ] **CONN-05**: Монитор связи не вызывает ложных переподключений VPN

### Update UX

- [ ] **UPD-01**: Release notes отображаются с рендерингом markdown (заголовки, списки, bold/italic)
- [ ] **UPD-02**: Длинный changelog скроллится, не обрезается

### Credentials

- [ ] **CRED-01**: Иконка генерации случайного username внутри поля ввода
- [ ] **CRED-02**: Иконка генерации случайного пароля внутри поля ввода
- [ ] **CRED-03**: Генератор доступен во всех формах добавления VPN-пользователей (wizard + server panel)

### Release

- [ ] **REL-01**: NSIS-инсталлятор Pro собран и выложен на рабочий стол
- [ ] **REL-02**: NSIS-инсталлятор Light собран и выложен на рабочий стол

## Future Requirements

None currently deferred.

## Out of Scope

| Feature | Reason |
|---------|--------|
| TrustTunnel Light feature parity with Pro | Separate milestone |
| Mobile apps | Desktop-first |
| Real-time server metrics dashboard | v2.0 redesign scope |
| Auto-update without user confirmation | Security — user must approve |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CONN-01 | Phase 1 | Pending |
| CONN-02 | Phase 1 | Pending |
| CONN-03 | Phase 1 | Pending |
| CONN-04 | Phase 1 | Pending |
| CONN-05 | Phase 1 | Pending |
| UPD-01 | Phase 2 | Pending |
| UPD-02 | Phase 2 | Pending |
| CRED-01 | Phase 3 | Pending |
| CRED-02 | Phase 3 | Pending |
| CRED-03 | Phase 3 | Pending |
| REL-01 | Phase 4 | Pending |
| REL-02 | Phase 4 | Pending |

**Coverage:**
- v2.5.0 requirements: 12 total
- Mapped to phases: 12
- Unmapped: 0

---
*Requirements defined: 2026-04-10*
*Last updated: 2026-04-10 after roadmap creation*
