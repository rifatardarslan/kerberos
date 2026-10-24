# KERBEROS

Yerel ajan CLI'larını (**Claude Code**, **Codex**, **OpenCode**, **Antigravity/agy**) tek bir çatı altında toplayan, iki aşamalı (**Planlama → Onay → Kodlama**) çalışan, Ink tabanlı TUI'si ve Telegram uzaktan kontrolü olan çoklu ajan geliştirici daemon'ı.

```
┌ KERBEROS ▸ C:\proje ─────────── [PLANNING] ⠋ DEBATING  şef Claude  tg ● ┐
│ ● Claude ★ ŞEF   ◐ Codex işçi   ◐ OpenCode işçi   ● Antigravity işçi    │
│ [Claude] Mimari taslak: src/auth.js içinde JWT…   │ KONSENSÜS PLANI      │
│ [Codex] OBJECT: refresh token stratejisi eksik…   │ • src/auth.js        │
│ ❯ Ne inşa edelim?                                  C kodu yazdır · P …   │
```

## Kurulum

```bash
cd Kerberos
npm install
npm run build        # src/ → dist/kerberos.js
npm link             # global `kerberos` komutu
```

> npm 11+ `prepare` betiğini onaysız çalıştırmaz (`allowScripts` uyarısı). Bu yüzden `npm run build` adımını elle çalıştırın ya da betiği bir kez `npm install-scripts approve kerberos` ile onaylayın. Kaynak kodu her değiştirdiğinizde yeniden `npm run build` çalıştırın; link'li komut güncel bundle'ı kullanır.

Gereksinimler: Node ≥ 20, git, ve kullanmak istediğiniz CLI'lardan en az biri PATH'te (`claude`, `codex`, `opencode`, `agy`). Bulunamayan CLI'lar başlangıçta devre dışı bırakılır.

## Kullanım

```bash
cd /calisilacak/proje
kerberos                      # tam ekran TUI
kerberos --headless           # TUI'siz: Telegram ve stdin ile kontrol (daemon)
kerberos --chief codex --rounds 2 --timeout 240 --no-telegram
```

**Çalışma alanı (workspace jail):** `kerberos` hangi dizinde çalıştırılırsa orası köktür. Bütün alt süreçler bu dizinde (`cwd`) çalışır. Dosyalara **yalnızca Kerberos** yazar: ajan CLI'ları salt-okunur ya da plan modunda çağrılır. Kerberos her yazmayı `resolveSafe` kontrolünden geçirir ve şunları reddeder:
- `..` ile dizin dışına çıkma, mutlak yollar, sürücü harfi;
- sembolik bağ üzerinden kaçış;
- `.git/`, `.kerberos/`, `node_modules/`, `.env` gibi korumalı yollar.

### Akış

1. **Planlama:** Prompt önce şefe gider. Şef bir taslak çıkarır, işçiler bu taslağı paralel olarak eleştirir (`debateRounds` kez). Bu aşamada tam kod üretimi yasaktır. Ardından şef `ARCH_PLAN` JSON'unu sentezler ve durum `ONAY BEKLİYOR` olur.
2. **Onay:** TUI'de `C` tuşuyla ya da Telegram'da 🚀 butonuyla verilir. `P` ya da 🔄 yeniden planlatır. Bu aşamada yazılan metin geri bildirim olarak plana eklenir.
3. **Kodlama:** Önce sessiz bir git snapshot alınır. Şef işi dosya bazlı görevlere böler, işçiler her dosyanın tam içeriğini üretir ve Kerberos dosyaları yazar. Bir işçi hata verirse görev yedek işçiye geçer.
4. **Sonuç:** Diff özeti gösterilir. `U` / ↩️ geri alır, `A` / 👍 kabul eder.

### TUI kısayolları

| Mod | Tuş | İşlev |
|---|---|---|
| yazma | `Enter` | prompt gönder (onay beklerken: yeniden planla + geri bildirim) |
| yazma | `Esc` | komut moduna geç |
| komut | `C` | planı onayla, kodlamayı başlat |
| komut | `P` | yeniden planla |
| komut | `X` | iptal / acil durdur |
| komut | `U` | rollback |
| komut | `A` | sonucu kabul et |
| komut | `PgUp/PgDn ↑↓` | tartışmayı kaydır |
| komut | `Enter` / `I` | yazma moduna dön |
| her ikisi | `Tab` | ajan ayarları: `←/→` seç, `S` şef yap, `M` model, `E` effort/variant |
| her ikisi | `Ctrl+C` / `Q` | çıkış (tüm alt süreçler öldürülür) |

Slash komutları her iki modda da çalışır: `/approve /replan <not> /cancel /abort /rollback /accept /chief <id> /quit`.

## Telegram

`.env` dosyası (çalışma dizininde ya da Kerberos kurulum dizininde):

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ALLOWED_USER_ID=11111111
```

- Bot yalnızca `TELEGRAM_ALLOWED_USER_ID` ile eşleşen kullanıcıya yanıt verir. Diğer kullanıcılardan gelen mesajlar ve buton tıklamaları sessizce yok sayılır.
- Bota önce bir kez `/start` yazın. Telegram, kullanıcı başlatmadan botun mesaj göndermesine izin vermez.
- Gönderilen bildirimler:
  - tartışma başladı;
  - plan özeti ve `🚀 Kodu Yazdır` / `🔄 Yeniden Planla` / `🛑 İptal` butonları;
  - diff özeti ve `↩️ Geri Al` / `👍 Kabul Et` butonları;
  - şef değişimi ve hatalar.
- Canlı tartışma logu Telegram'a **gönderilmez**.
- Komutlar: `/status`, `/plan <metin>` (ya da düz mesaj), `/approve`, `/cancel`, `/rollback`, `/abort` (acil durdurma).
- Senkronizasyon çift yönlüdür: TUI'de verilen onay Telegram'daki mesajı "✅ Onaylandı (TUI'den)" olarak günceller, Telegram'dan verilen onay TUI'yi anında günceller. Aynı anda iki onay gelirse yalnızca ilki geçerli olur.

## Yapılandırma

Öncelik sırası (düşükten yükseğe): varsayılanlar < `~/.kerberosrc` < `<cwd>/kerberos.config.json` < `<cwd>/.kerberosrc` < ortam değişkenleri.

```json
{
  "chief": "claude",
  "fallbackChief": "codex",
  "workers": ["codex", "opencode", "agy"],
  "debateRounds": 1,
  "timeoutMs": 180000,
  "maxConcurrency": 3,
  "agentCooldownMs": 120000,
  "agents": {
    "claude":   { "model": "opus", "effort": "high", "thinkingTokens": 16000, "models": ["opus", "sonnet"] },
    "codex":    { "model": "gpt-5-codex", "effort": "medium" },
    "opencode": { "model": "anthropic/claude-sonnet-4-5", "variant": "high" },
    "agy":      { "effort": "medium" },
    "ollama":   { "type": "generic", "label": "Ollama", "bin": "ollama", "args": ["run", "qwen2.5-coder"] }
  }
}
```

`model: null` CLI'ın kendi varsayılan modelini kullanır. `type: "generic"` ile stdin'den prompt alıp düz metin döndüren herhangi bir CLI eklenebilir.

### CLI bayrak eşlemesi

Spec'teki bazı bayraklar gerçek CLI'larda yok. Kerberos onları şu şekilde eşler:

| Ayar | Claude | Codex | OpenCode | agy |
|---|---|---|---|---|
| çağrı | `claude -p --output-format stream-json` | `codex exec --json -o <tmp> -` | `opencode run --format json` | `agy --input-format stream-json --output-format stream-json` |
| model | `--model` | `-m` | `-m provider/model` | `--model` |
| effort | `--effort low…max` | `-c model_reasoning_effort="…"` | `#variant` (temperature bayrağı **yok**) | `--effort` |
| thinking bütçesi | `MAX_THINKING_TOKENS` env (`--max-thinking-tokens` bayrağı **yok**) | — | — | — |
| salt-okunur | `--tools Read,Grep,Glob --strict-mcp-config` | `-s read-only` | `--agent plan` | `--mode plan` |
| prompt | stdin | stdin | stdin | stdin (NDJSON `{"event":"user",…}`) |

Windows'ta komut satırı 32K karakterle sınırlıdır. Bu yüzden prompt'lar hiçbir zaman argv ile değil, her zaman stdin üzerinden gönderilir.

## Dayanıklılık

- **Deadlock koruması:** Bir CLI `timeoutMs` (varsayılan 180 sn) boyunca hiç çıktı üretmezse süreç ağacıyla birlikte öldürülür (Windows'ta `taskkill /T /F`, diğer sistemlerde `SIGKILL`) ve görev yedek işçiye aktarılır.
- **Hata sınıflandırması:** Hatalar dört gruba ayrılır:
  - `RATE_LIMIT` (429, quota, usage limit…) ve `AUTH`: retry yapılmaz, ajan bir süre beklemeye alınır (cooldown);
  - `CRASH`: aynı ajanda bir kez yeniden denenir;
  - `NOT_FOUND`: ajan devre dışı bırakılır.
- **Şef failover:** Oturum durumu (prompt, tree, tartışma transkripti, plan) CLI'larda değil Kerberos'ta tutulur ve her çağrı tam bağlamla yapılır. Şef hata verirse şeflik kayıpsız biçimde `fallbackChief`'e (Codex) devredilir ve aynı istek yeniden gönderilir.
- **Rollback:** Snapshot'lar `.kerberos/shadow.git` içindeki ayrı bir git deposunda tutulur. Kendi reponuza (branch, index, stash) dokunulmaz ve git olmayan dizinlerde de çalışır. Son snapshot `.kerberos/session.json` dosyasına kaydedilir, böylece Kerberos yeniden başlatıldıktan sonra da geri alma yapılabilir.

## Geliştirme

```bash
npm test        # node:test (jail, protokol, state machine, adapter timeout/failover, orchestrator, snapshot)
npm run build   # src/ → dist/kerberos.js (esbuild, JSX)
```

```
bin/kerberos.js            CLI girişi
src/index.js               bootstrap (config → workspace → orchestrator → TUI/headless → telegram)
src/config/config.js       .kerberosrc / kerberos.config.json / .env
src/adapters/              base-adapter (spawn, idle timeout, hata sınıflandırma, retry) + claude/codex/opencode/agy
src/core/state-machine.js  IDLE → DEBATING → AWAITING_APPROVAL → BUILDING → DONE (+ ABORTED/ERROR)
src/core/orchestrator.js   şef-işçi tartışması, görev dağıtımı, failover
src/core/workspace.js      jail, tree, shadow-git snapshot/rollback
src/core/process-pool.js   eşzamanlılık limiti, killAll
src/core/protocol.js       ARCH_PLAN / görev şemaları (zod), dosya zarfı ayrıştırıcı
src/core/prompts.js        PLANNING_MODE / CODING_MODE rol promptları
src/remote/telegram.js     Telegram köprüsü
src/ui/                    Ink TUI
```
