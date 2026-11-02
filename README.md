# KERBEROS

Yerel ajan CLI'larını (**Claude Code**, **Codex**, **OpenCode**, **Antigravity/agy**) tek bir çatı altında toplayan, iki aşamalı (**Planlama → Onay → Kodlama**) çalışan, Ink tabanlı TUI'si ve Telegram uzaktan kontrolü olan çoklu ajan geliştirici daemon'ı.

```
╭─── Kerberos v0.2.0 ───────────────────────────────────────────────────────────╮
│                                         │ Başlarken                           │
│        Tekrar hoş geldin, Arda!         │ Görev ya da soru yazın; şef karar…  │
│                                         │ @ ile dosya ekleyin, /help ile ko…  │
│       ▲   ▲     ▲   ▲     ▲   ▲         │ ─────────────────────────────────── │
│      ▟█▙▄▟█▙   ▟█▙▄▟█▙   ▟█▙▄▟█▙        │ Son etkinlik                        │
│      █ ◉ ◉ █   █ ◉ ◉ █   █ ◉ ◉ █        │ 3 sa önce  JWT ile giriş ekle       │
│      ▜█▄▼▄█▛   ▜█▄▼▄█▛   ▜█▄▼▄█▛        │ dün        Testleri hızlandır       │
│        ▀█▄▄▄▄▄▄▄▄█▀█▄▄▄▄▄▄▄▄█▀          │                                     │
│            ▜█████████████▛              │                                     │
│             ▐█▌ ▐█▌ ▐█▌ ▐█▌             │                                     │
│                                         │                                     │
│      claude-opus-5-5 · şef Claude       │                                     │
│            Codex · OpenCode             │                                     │
│             C:\Projeler\api             │                                     │
╰───────────────────────────────────────────────────────────────────────────────╯

> JWT auth ekle

● Claude(taslak) · 12s · 16k token
  ⎿  src/auth.js içinde JWT imzalama, argon2 ile hash…
     … +8 satır (ctrl+o ile genişlet)

● Codex(eleştiri)
  ⎿  refresh token rotasyonu eksik

✶ Kokluyor… (8s · ↓ 1.2k token)

─────────────────────────────────────────────────────────────────────────────────
> Yazmaya devam edin, tur bitince gönderilir
─────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ otomatik kodlama açık (shift+tab ile değiştir)                          ● RC
```

## Kurulum

```bash
cd Kerberos
npm install
npm run build        # src/ → dist/kerberos.js
npm link             # global `kerberos` komutu
```

> npm 11+ `prepare` betiğini onaysız çalıştırmaz (`allowScripts` uyarısı). Bu yüzden `npm run build` adımını elle çalıştırın ya da betiği bir kez `npm install-scripts approve kerberos` ile onaylayın. Kaynak kodu her değiştirdiğinizde yeniden `npm run build` çalıştırın; link'li komut güncel bundle'ı kullanır.

Gereksinimler: Node ≥ 20 (OpenCode'un son kullanılan modelini göstermek için ≥ 22.5, `node:sqlite`), git ve kullanmak istediğiniz CLI'lardan en az biri PATH'te (`claude`, `codex`, `opencode`, `agy`). Bulunamayan CLI'lar devre dışı kalır; `/doctor` hangisinin neden eksik olduğunu ve kurulum komutunu gösterir.

## Kullanım

```bash
cd /calisilacak/proje
kerberos                      # yeni oturum, etkileşimli TUI
kerberos -c                   # bu dizindeki son oturuma devam et
kerberos -r                   # oturum listesinden seç
kerberos -r 5eac3192          # belirli oturuma devam et (tam id ya da önek)
kerberos --rc                 # RC açık başlat
kerberos --headless           # TUI'siz daemon: RC her zaman açık, stdin'den de komut alır
kerberos --chief codex --rounds 2 --timeout 240 --no-telegram
kerberos --lang tr            # bu açılış için Türkçe arayüz (kalıcı ayar: /config → Language)
```

**Çalışma alanı (workspace jail):** `kerberos` hangi dizinde çalıştırılırsa orası köktür. Bütün alt süreçler bu dizinde (`cwd`) çalışır. Dosyalara **yalnızca Kerberos** yazar: ajan CLI'ları salt-okunur ya da plan modunda çağrılır. Kerberos her yazmayı `resolveSafe` kontrolünden geçirir ve şunları reddeder:
- `..` ile dizin dışına çıkma, mutlak yollar, sürücü harfi;
- sembolik bağ üzerinden kaçış;
- `.git/`, `.kerberos/`, `node_modules/`, `.env` gibi korumalı yollar.

Ek olarak, bir ajan salt-okunur modda olmasına rağmen akışında dosya yazma aracı çağırırsa (ör. agy'nin `write_to_file`'ı) süreç anında öldürülür ve ajan bu oturumda devre dışı kalır (`POLICY` hatası).

### Oturumlar

Her `kerberos` çalıştırması bir **oturum** açar (Claude Code'daki `--resume` / Codex'teki `resume` gibi):

- `.kerberos/sessions/<uuid>.json` oturumun meta verisidir: başlık, turlar ve sonuçları, şef ve ajan ayarları, izin modu, RC durumu, Telegram konusu ve harcanan token'lar. `<uuid>.jsonl` ise ekran transkriptidir.
- Oturum, ilk görevle ya da ilk ayarla diske yazılır. Boş açılıp kapatılan oturum iz bırakmaz.
- Çıkışta `Sürdürmek için: kerberos --resume 5eac3192` satırı basılır.
- **Devam ederken** transkript yeniden basılır; şef, model/effort seçimleri ve izin modu geri yüklenir. RC o oturumda açıksa yine açılır. Son kodlama kabul edilmiş sayılır ama `/undo` ile hâlâ geri alınabilir.
- **Sohbet hafızası ve bağlam:** Ajanlar her çağrıda durumsuzdur; Kerberos konuşmayı kendisi tutar ve her prompt'a "Earlier in this conversation" bloğu ekler. "Az önceki değişikliği geri al, şunu da ekle" gibi takip istekleri bu sayede çalışır. Şef failover'ı da kayıpsız kalır. Blok, sohbet ne kadar uzarsa uzasın sınırlı kalır:
  - son 6 tur ayrıntılı yazılır (istek, geri bildirim, plan özeti, değişen dosyalar, sonuç; en fazla ~6k karakter);
  - daha eski turlar tur başına tek satıra iner (en fazla ~1.5k karakter);
  - `/compact [odak]` o ana kadarki sohbeti şefe özetletir. Sonraki prompt'lar o turların yerine bu özeti (en fazla ~4k karakter) taşır. Özet oturumda saklanır, `--resume` ile geri gelir;
  - `/clear` bağlamı tamamen sıfırlayıp yeni oturum açar.
- v0.1'deki `.kerberos/session.json` ilk açılışta bir oturuma taşınır (`session.json.bak`).

### Akış ve izin modları

**Şef önce değerlendirir (triyaj).** Her mesaj önce şefe gider. Şefin ilk yanıtı mesajın türünü de söyler; bu yüzden değerlendirme ayrıca bir çağrı ya da token harcamaz:

| Tür | Örnek | Ne olur |
|---|---|---|
| sohbet | "selam", "teşekkürler" | Yalnızca şef kısaca yanıtlar, işçiler hiç çağrılmaz. Oturuma ve Telegram konusuna ad olmaz. |
| soru | diferansiyel denklem, algoritma, "bu kod neden yavaş" | Şef kendi çözümünü yazar, işçiler birbirinden bağımsız çözer, şef sonuçları karşılaştırıp tek yanıt verir. Plan ve onay adımı yoktur, dosyalara dokunulmaz. |
| görev | "JWT auth ekle" | Aşağıdaki plan → onay → kodlama akışı. Şefin ilk yanıtı zaten taslaktır. |
| netleştirme | "bir site yap, önce bana sor" | Şef, sonucu çok değiştiren kararları (ya da siz istediyseniz) tartışmadan **önce** sorar: en fazla 4 soru, her biri 2–4 seçenekli. TUI'de sorular Claude Code'daki gibi sekmelerdir: `←/→` sekmeler arasında gezer, `↑↓`/numara seçer, çoklu seçimde işaretlenip `Sonraki →` denir, `Diğer` satırında yanıt doğrudan yazılır. Son sekme yanıtların inceleme ekranıdır (`Yanıtları gönder` · `İptal`); tek soruda seçim doğrudan gönderilir. `esc` kutuyu gizler, boş `Enter` yeniden açar. Telegram'da seçenekler buton olur; numara ya da serbest metin yazmak da yeter. Yanıtlar isteğe eklenir ve plan akışı başlar. `/cancel` soruları iptal eder. |

Şef emin değilse sohbet yerine soru seçer. `/plan <metin>` değerlendirmeyi atlayıp doğrudan kod görevi başlatır, `/ask <soru>` doğrudan bütün ajanlara sorar. `/config` → "Şef önce değerlendirsin" ile kapatılırsa her mesaj eskisi gibi plana gider.

1. **Planlama:** Prompt önce şefe gider. Şef bir taslak çıkarır, işçiler bu taslağı paralel olarak eleştirir (`debateRounds` kez). Bu aşamada tam kod üretimi yasaktır. Ardından şef `ARCH_PLAN` JSON'unu sentezler.
2. **Onay:** Mod `onaylı` ya da `yalnızca plan` ise bir seçim kutusu açılır: `Evet, kodla` · `Evet, bundan sonra sormadan kodla` (otomatik moda geçer) · `Hayır, planlamaya devam et` (geri bildirim yazılır) · `İptal`. İlk seçenek seçili gelir, yani plan bitince tek `Enter` kodlamayı başlatır. Kutu `esc` ile gizlenirse boş `Enter` onu yeniden açar; bu sırada prompt'a yazılan metin geri bildirim olarak plana eklenir.
3. **Kodlama:** Önce sessiz bir git snapshot alınır. Şef işi dosya bazlı görevlere böler (kısa yönergelerle; işçiler planın tamamını zaten görür), işçiler her dosyanın tam içeriğini üretir ve Kerberos dosyaları yazar. Bir işçi hata verirse görev yedek işçiye geçer. Yanıtı akış hâlinde değil tek parça veren CLI'lar (Codex, OpenCode) büyük bir dosyayı yazarken uzun süre sessiz kalabildiği için kodlamada sessizlik sınırları `timeoutMs`'in üç katıdır.
4. **Çapraz inceleme:** Her ajan, diğerlerinin yazdığı dosyaları inceler (kimse kendi dosyasını incelemez): hatalar, eksikler, güvenlik, optimizasyon, erişilebilirlik. Bulgular dosya başına toplanır ve dosyanın yazarına gider; yazar doğru olanları uygular (`review.rounds`, varsayılan 1).
5. **Site kontrolü (web projeleri):** Kerberos siteyi kendisi açar: düz HTML/CSS için kendi sunucusuyla, npm projelerinde `npm install` + `npm run dev` ile (plan kutusunda "sonra: … (npm install + dev sunucu)" yazar; onay bunu da kapsar). Gizli Chrome/Edge'de masaüstü (1440px) ve telefon (390px) genişliğinde sayfaları gezer, butonlara tıklar; JS hatalarını, başarısız istekleri, ölü butonları, taşmaları toplar ve ekran görüntüsü alır (`.kerberos/preview/`). Her ajan ekran görüntülerini ve raporu inceler; bulgular dosya sahiplerine gider, sonra site son kez kontrol edilir. Görsel okuyamayan modeller (ör. bazı OpenCode modelleri) rapordan ve dosyalardan değerlendirir. `/config` → "Site kontrolü": açık / yalnızca statik / kapalı.
6. **Sonuç:** Diff özeti basılır ve değişiklik kabul edilmiş sayılır; ayrıca sorulmaz. Geri almak için `/undo` (Telegram'da ↩️) kullanılır.

İzin modu Claude Code'daki gibi `shift+tab` ile döner (onaylı → otomatik → yalnızca plan) ve prompt'un altındaki satırda görünür. `shift+tab` yalnızca o oturumu etkiler; varsayılan modu `/mode` ya da `/config` kaydeder.

`onaylı` ile `yalnızca plan` arasındaki fark Claude Code'dakiyle aynıdır: ikisinde de kod ancak onayla yazılır. `onaylı` modda onay kutusu her planda açılır ve mod değişmez. `yalnızca plan` modunda ise planı serbestçe tartışırsınız; kutuda (alt başlıkta "plan modundan çıkılır" yazar) ya da `/approve` / Telegram'da `🚀 Kodla` ile onay verilirse oturum plan modundan çıkıp `onaylı` moda geçer ve kodlama başlar. Planı onaylamadan bırakmak isterseniz `Hayır, planlamaya devam et` deyip yazmaya devam edersiniz.

| Mod | Davranış |
|---|---|
| `onaylı` (varsayılan) | yalnızca plan onayı istenir |
| `⏵⏵ otomatik` | plan onaysız kodlanır; plan boşsa ya da şefin soruları varsa yine sorulur |
| `⏸ yalnızca plan` | tartışma ve plan üretilir, kod yazılmaz |

### Modeller ve kullanım

- "varsayılan" yerine gerçek değerler gösterilir. Kerberos her CLI'ın kendi ayarını okur: `~/.claude/settings.json`, `~/.codex/config.toml`, OpenCode config'i (yoksa son kullanılan model) ve agy'nin son kullandığı model. Çalışma anında CLI'ın bildirdiği tam model adı da yakalanır. Örnekler: `CLI varsayılanı · gpt-6.1-sol · high`, `opus → claude-opus-5-5`.
- `/model [ajan]` CLI'ların canlı model listesini açar (`codex app-server model/list`, `opencode models`, `agy models`). Liste 24 saat `~/.kerberos/cache/models.json` dosyasında önbelleklenir. `/effort` seçilen modelin desteklediği seviyeleri listeler.
- `/usage` (`/cost`) her ajanın kalan limitini bar olarak gösterir: 5 saatlik pencere, haftalık pencere ve sıfırlanma zamanı. Ayrıca bu oturumda harcanan token ve maliyeti verir.
  - Claude limitleri her çağrıda akıştan okunur.
  - Codex limitleri `codex app-server` üzerinden anlık sorgulanır.
  - OpenCode ve agy kalan limit bildirmez; onlar için yalnızca token sayılır.

### Arayüz

Arayüz Claude Code / Codex CLI'ı örnek alır. Tamamlanan çıktılar (ajan yanıtları, plan, yazılan dosyalar, diff) terminalin kendi geçmişine basılır ve yukarı kaydırılabilir. Görünüm Claude Code ile aynıdır: kullanıcıya verilen yanıtlar `●` ile, ara ajan çıktıları (taslak, eleştiri, çözüm) `● Codex(eleştiri)` gibi araç çağrısı olarak basılır ve 4 satırda kısaltılır (`ctrl+o` genişletir). Ekranın altında çalışan ajanlar, tek satırlık `✻ … (24s · ↓ 1.2k token)` göstergesi, iki çizgi arasındaki prompt ve alt satır durur.

| Tuş | İşlev |
|---|---|
| `Enter` | gönder. Ajanlar çalışırken yazılan mesaj kuyruğa alınır, tur bitince gönderilir |
| `\` + `Enter`, `alt+Enter` | yeni satır (yapıştırılan çok satırlı metin de korunur) |
| `/` | komut menüsü: `↑↓` seç, `Tab` tamamla, `Enter` çalıştır |
| `@` | dosya bahsetme: workspace'ten tamamlama yapar, dosya içeriği bağlama eklenir |
| `shift+tab` | izin modunu değiştir |
| `ctrl+o` | son kısaltılmış çıktının tamamını göster |
| `↑ ↓` · `ctrl+r` | prompt geçmişi (proje bazlı, kalıcı: `~/.kerberos/history.jsonl`) · geçmişte ara |
| `Backspace` · `ctrl+Backspace` (`alt+Backspace`, `ctrl+w`) | bir karakter sil · imleçten önceki kelimeyi sil |
| `ctrl+a/e/u/k`, `alt+←/→` | satır başı/sonu, satırı sil, kelime atla |
| `Esc` | çalışan ajanları durdur · girişi temizle · seçim kutusunu kapat |
| `?` | kısayol paneli (boş prompt'ta) |
| `Ctrl+C` ×2 | çıkış (tüm alt süreçler öldürülür) |

Terminal penceresi yeniden boyutlanınca (ör. ekranın yarısına yaslanınca) Kerberos ekranı temizleyip geçmişi yeni genişliğe göre yeniden basar; eski genişlikte kırılmış satırlar kalmaz.

**Seçince kopyalama:** Metin seçimini terminal yapar; Kerberos mouse'u yakalamaz, böylece tekerlekle geçmişte kaydırma çalışmaya devam eder. Claude Code'daki gibi seçer seçmez kopyalanması için Windows Terminal'de **Ayarlar → Etkileşim → "Seçimi otomatik olarak panoya kopyala"** açılmalıdır (`settings.json`: `"copyOnSelect": true`). iTerm2'de "Copy to pasteboard on selection" ayarı aynı işi görür; çoğu Linux terminali bunu zaten yapar. Windows'ta Kerberos pano olaylarına abone olur (yoklama yok): terminalden bir şey kopyalanınca durum satırında `✓ 128 karakter kopyalandı · 3 satır` görünür.

### Dil

Arayüz varsayılan olarak **İngilizcedir**. `/config` → **Language** ile `English`, `Türkçe` ya da `Auto (system)` (sistem dili; çevirisi yoksa İngilizce) seçilir ve `~/.kerberos/settings.json`'a kaydedilir. Tek açılış için `--lang tr`, ortam için `KERBEROS_LANG=tr` kullanılabilir. Telegram mesajları ve `/` menüsü de aynı dili kullanır.

Ajanların **yanıt dili** arayüz dilinden ayrıdır: varsayılan `replyLanguage: "auto"` sistem dilidir (Türkçe bir Windows'ta Türkçe). Siz başka bir dilde yazarsanız ajanlar o dilde yanıt verir. Sabitlemek için config'e `"replyLanguage": "en"` (ya da `"German"` gibi bir dil adı) yazılır veya `KERBEROS_REPLY_LANG` kullanılır. Prompt'lar, talimat takibi daha iyi olduğu için her zaman İngilizcedir.

Bu README Türkçe arayüzdeki adları kullanır. İngilizce arayüzdeki karşılıkları: `onaylı` = `ask`, `otomatik` = `auto`, `yalnızca plan` = `plan only`, `Evet, kodla` = `Yes, code it`.

### MCP sunucuları ve skill'ler

Claude, kendi MCP sunucularınızla (claude.ai konnektörleri dahil) ve skill'lerinizle çalışır; Claude Code'da ne açıksa ajanlar da onu görür. Codex, OpenCode ve agy MCP sunucularını zaten kendi ayar dosyalarından yükler. Güvenlik notu: Claude `-p` (print) modunda izin soramaz, bu yüzden bir MCP aracı yalnızca Claude Code'daki izinleriniz (`permissions.allow`) ona izin veriyorsa çalışır; dosya yazma araçları ise her durumda kapalıdır. Kapatmak için `agents.claude` altında `"mcp": false` (`--strict-mcp-config`) ve/veya `"skills": false` (`--disable-slash-commands`) yazılır.

### Slash komutları

| Komut | İşlev |
|---|---|
| `/help` | komutlar ve kısayollar |
| `/status` | oturum, mod, ayarların kaynağı, ajan başına model/effort |
| `/usage` (`/cost`) | kalan limitler ve harcanan token |
| `/agents` | ajan yönetimi: şef yap, model, effort/variant |
| `/model [ajan]` · `/effort [ajan]` | model / reasoning effort seçimi (kalıcı) |
| `/chief <ajan>` | şefi değiştir (kalıcı) |
| `/mode [default\|auto\|plan]` | izin modu |
| `/plan <görev>` · `/ask <soru>` | değerlendirmeyi atla: doğrudan kod görevi · bütün ajanlara soru |
| `/approve` · `/replan [not]` · `/cancel` | plan onayı, yeniden planlama, iptal |
| `/abort` (`/stop`) | çalışan ajanları acil durdur |
| `/diff` · `/undo` (`/rollback`) | son kodlamanın diff'i, geri alma |
| `/clear` (`/new`) | yeni sohbet: bağlam sıfırlanır, ekran temizlenir (önceki oturum `/resume` ile açılır) |
| `/compact [odak]` | sohbet geçmişini şefe özetlet; sonraki görevler özeti görür |
| `/resume` · `/rename <ad>` | oturuma devam et, oturuma ad ver |
| `/config` | arayüz dili, çapraz inceleme, site kontrolü, varsayılan izin modu, RC otomatik başlasın mı, şef triyajı, tartışma tur sayısı |
| `/doctor` | CLI'lar ve sürümleri, git, Telegram bağlantısı ve konu modu |
| `/init` | bu dizine `kerberos.config.json` yaz |
| `/rc [on\|off]` | Telegram uzaktan kontrolü aç/kapat (oturumda hatırlanır) |
| `/exit` (`/quit`) | çıkış |

## Telegram

`.env` dosyası (çalışma dizininde ya da Kerberos kurulum dizininde):

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ALLOWED_USER_ID=11111111
```

- **RC modu:** TUI'de uzaktan kontrol kapalı başlar. `/rc` ile açılıp kapatılır, durum oturumda saklanır: RC açıkken çıkılan bir oturuma `kerberos -c` ile dönülünce RC kendiliğinden açılır. Her zaman açık başlaması için `--rc` bayrağı ya da `/config` → "RC otomatik" ayarı kullanılır. `--headless` modda RC her zaman açıktır.
- **Her proje klasörü ayrı bir konu (topic):** Bot sohbetinde her klasörün tek bir konusu olur (`📁 klasör`, ilk görevden sonra `📁 klasör · görev başlığı`).
  - Aynı klasörde açılan yeni oturum aynı konuyu kullanır; konuya `🆕 Yeni sohbet <id>` ya da `↩️ Sohbet sürüyor` ayracı düşer.
  - Aynı klasörde aynı anda iki Kerberos açıksa ikincisi ayrı bir konu alır.
  - Bir konuya yazılan mesaj yalnızca o projenin Kerberos'una gider.
- **🐺 Kerberos lobisi:** Konu modunda konuların dışında bir "ana sohbet" yoktur; Telegram, konu dışına yazılan her mesaj için kendiliğinden yeni bir konu açar. Bu yüzden Kerberos sabit bir **🐺 Kerberos** konusu açar. `/sessions` açık oturumları listeler; lobide de proje konularında da çalışır. Kendiliğinden açılan konulara da yanıt verilir ve lobiye yönlendirilir; bu konular silinebilir.
- Kapalı bir projenin konusuna yazılırsa bot, bilgisayarda çalıştırılacak `kerberos --resume <id>` komutunu yanıt olarak verir.
  - Bunun için botta konu modunun açılması gerekir: **@BotFather sohbetinde "Open" (Mini App) → My bots → botunuz → Bot Settings → Threads Settings → Threaded Mode** (Bot API 9.3/9.4). Klasik `/mybots` metin menüsünde bu ayar yoktur. Kapalıysa her şey tek sohbete akar, en son açılan Kerberos dinler; `/doctor` bunu gösterir.
- **Birden fazla Kerberos:** Aynı token'la aynı anda yalnızca bir süreç Telegram'ı dinleyebilir. Bu yüzden RC açık ilk Kerberos yerel bir **hub** kurar (Windows'ta named pipe, diğer sistemlerde `~/.kerberos/tg-*.sock`). Gelen mesajları konusuna göre ilgili sürece o iletir. Hub kapanırsa kalan süreçlerden biri dinlemeyi devralır. Ayrı bir daemon gerekmez.
- Bot yalnızca `TELEGRAM_ALLOWED_USER_ID` ile eşleşen kullanıcıya yanıt verir. Diğer kullanıcılardan gelen mesajlar ve buton tıklamaları sessizce yok sayılır.
- Bota önce bir kez `/start` yazın. Telegram, kullanıcı başlatmadan botun mesaj göndermesine izin vermez.
- **Bir turun görünümü:**
  - **Sohbet:** Bildirim gelmez; yalnızca "yazıyor…" görünür, ardından şefin yanıtı gelir.
  - **Soru ve görev:** Tek bir **canlı kart** açılır ve yerinde güncellenir. Kartta geçen süre, o anki aşama ("Ekip taslağı eleştiriyor…") ve her ajan için ⏳ / ✅ süre / ⚠️ hata satırı görünür. Kodlama sırasında dosya başına ilerleme gösterilir (`2/3`). Kartın altındaki `⏹ Durdur` butonu turu durdurur. Tur bitince kart tek satıra iner ve sonuç ayrı bir mesaj olarak gelir.
  - **Yanıtlar:** Ajanların Markdown çıktısı Telegram biçimine çevrilir: kalın/eğik, `kod`, renklendirilmiş kod blokları, maddeler, alıntılar, linkler. Tablolar eş aralıklı yazılır. Uzun yanıtlar kod bloğu bölünmeden birkaç mesaja ayrılır.
  - **Plan kartı:** Özet, değişecek dosyalar ve şefin soruları görünür; bağımlılıklar ve riskler açılır kapanır bir alanda durur. Butonlar: `🚀 Kodla`, `✖️ İptal`, `⏩ Kodla · bundan sonra sorma` (otomatik moda geçip onaylar). Değişiklik istemek için yanıt yazmak yeterlidir.
  - **Soru kartı:** Şef netleştirme sorusu sorarsa her soru seçenek butonlarıyla gelir; çoklu seçimde ⬜/☑️ ile işaretlenip `✅ Tamam`'a basılır. Yanıtlanan soru kartın üstüne yazılır ve aynı mesaj sıradaki soruya geçer. Sorular TUI'den yanıtlanırsa kart da ilerler.
  - **Sonuç kartı:** Dosya başına durum ve `+eklenen −silinen` satır sayısı görünür. Çapraz inceleme ve site kontrolü özeti de yazar; site kontrolünün son ekran görüntüleri albüm olarak gelir. Butonlar: `↩️ Geri al` ve `📄 Diff` (değişiklikleri `changes.diff` dosyası olarak gönderir).
  - TUI'den başlatılan turlarda istek, kartın altında `🖥` ile alıntılanır.
- **`/status` kartı:** Klasör, durum, sohbet ve tur sayısı, mod, şef ve işçiler (modelleriyle) gösterilir. Kısayollar: `⚙️ Mod ▸` (kartın içinde döner), `🆕 Yeni sohbet`, `🗜 Özetle`; çalışırken `⏹ Durdur`, geri alınabilecek bir değişiklik varsa `↩️ Geri al`.
- **Komutlar** (sohbetteki `/` menüsünde arayüz dilindeki açıklamalarıyla listelenir):

  | Komut | Ne yapar |
  |---|---|
  | düz mesaj | Şef değerlendirir: sohbet, soru, görev ya da netleştirme. Şefin sorusu açıkken yazılan mesaj (ya da seçenek numarası) o sorunun yanıtıdır; plan onay beklerken yazılan mesaj plana geri bildirim olur. |
  | `/status` | Durum kartı ve kısayollar |
  | `/ask <soru>` · `/plan <görev>` | Bütün ekibe sor · doğrudan kod görevi |
  | `/new` · `/clear` | Yeni sohbet (aynı konu) · yeni sohbet ve bu oturumun mesajlarını sil (Telegram yalnızca son 48 saatin mesajlarını sildirir) |
  | `/compact [odak]` | Geçmişi şefe özetlet |
  | `/undo` · `/stop` | Son değişikliği geri al · çalışan ajanları durdur |
  | `/mode` | İzin modu; argümansız yazılırsa üç seçenek buton olarak gelir |
  | `/sessions` · `/help` | Açık projeler · yardım |

  Eski adlar da çalışır: `/approve`, `/cancel`, `/abort`, `/rollback`.
- Senkronizasyon çift yönlüdür: TUI'de verilen onay Telegram'daki plan kartını "✅ Onaylandı · TUI" olarak günceller, Telegram'dan verilen onay TUI'yi anında günceller. Aynı anda iki onay gelirse yalnızca ilki geçerli olur.
- Telegram bir mesajın biçimlendirmesini reddederse mesaj düz metin olarak yeniden gönderilir.
- Telefonda çalışma dizini değiştirilemez (bilinçli tasarım). Başka bir proje için o dizinde `kerberos --rc` açın; o klasörün konusu açılır.

## Yapılandırma

Öncelik sırası (düşükten yükseğe):
1. varsayılanlar
2. `~/.kerberosrc`
3. `~/.kerberos/settings.json` (`/model`, `/effort`, `/chief`, `/mode` ve `/config` buraya yazar)
4. `<cwd>/kerberos.config.json`
5. `<cwd>/.kerberosrc`
6. ortam değişkenleri (`KERBEROS_CHIEF`, `KERBEROS_TIMEOUT_MS`, `KERBEROS_LANG`, `KERBEROS_REPLY_LANG`, `MAX_THINKING_TOKENS`)

Bir oturuma devam edildiğinde o oturumun kendi seçimleri hepsinin üstüne yazılır. `KERBEROS_HOME` ortam değişkeni `~/.kerberos` dizininin yerini değiştirir.

```json
{
  "chief": "claude",
  "fallbackChief": "codex",
  "workers": ["codex", "opencode", "agy"],
  "permissionMode": "default",
  "language": "en",
  "replyLanguage": "auto",
  "debateRounds": 1,
  "review": { "enabled": true, "rounds": 1 },
  "preview": { "enabled": true, "rounds": 1, "npm": true, "pages": 4, "browser": null },
  "timeoutMs": 180000,
  "maxConcurrency": 3,
  "agentCooldownMs": 120000,
  "agents": {
    "claude":   { "model": "opus", "effort": "high", "thinkingTokens": 16000 },
    "codex":    { "model": null, "effort": null },
    "opencode": { "model": "opencode/big-pickle", "variant": "high" },
    "agy":      { "effort": null },
    "ollama":   { "type": "generic", "label": "Ollama", "bin": "ollama", "args": ["run", "qwen2.5-coder"] }
  }
}
```

`model: null` / `effort: null` CLI'ın kendi ayarını kullanır; arayüz bu ayarın ne olduğunu da gösterir. `type: "generic"` ile stdin'den prompt alıp düz metin döndüren herhangi bir CLI eklenebilir.

### CLI bayrak eşlemesi

Spec'teki bazı bayraklar gerçek CLI'larda yok. Kerberos onları şu şekilde eşler:

| Ayar | Claude | Codex | OpenCode | agy |
|---|---|---|---|---|
| çağrı | `claude -p --output-format stream-json` | `codex exec --json -o <tmp> -` | `opencode run --format json` | `agy --input-format stream-json --output-format stream-json` |
| model | `--model` | `-m` | `-m provider/model` | `--model` |
| effort | `--effort low…max` | `-c model_reasoning_effort="…"` | `#variant` (temperature bayrağı **yok**) | `--effort` |
| thinking bütçesi | `MAX_THINKING_TOKENS` env (`--max-thinking-tokens` bayrağı **yok**) | — | — | — |
| salt-okunur | `--tools Read,Grep,Glob,Skill` (+ kullanıcının MCP sunucuları) | `-s read-only` | `--agent plan` | `--mode plan` + yazma girişimi denetimi |
| prompt | stdin | stdin | stdin | stdin (NDJSON `{"event":"user",…}`) |

Windows'ta komut satırı 32K karakterle sınırlıdır. Bu yüzden prompt'lar hiçbir zaman argv ile değil, her zaman stdin üzerinden gönderilir.

> **agy notu:** `agy --disable-slash-commands` bayrağı `--mode plan`'ı sessizce devre dışı bırakıyor ve agy workspace'e dosya yazabiliyor. Bu davranış test ortamında doğrulandı. Kerberos bu bayrağı kullanmaz. Ayrıca agy'nin kendi `brain` dizini dışındaki her yazma aracı çağrısını ihlal sayar ve süreci öldürür.

## Dayanıklılık

- **Deadlock koruması:** Bir CLI `timeoutMs` (varsayılan 180 sn) boyunca hiç çıktı üretmezse süreç ağacıyla birlikte öldürülür (Windows'ta `taskkill /T /F`, diğer sistemlerde `SIGKILL`) ve görev yedek işçiye aktarılır.
- **Hata sınıflandırması:** Hatalar beş gruba ayrılır:
  - `RATE_LIMIT` (429, quota, usage limit…) ve `AUTH`: retry yapılmaz, ajan bir süre beklemeye alınır (cooldown). `AUTH` hatasında hangi giriş komutunun çalıştırılacağı gösterilir;
  - `CRASH`: aynı ajanda bir kez yeniden denenir;
  - `NOT_FOUND` ve `POLICY` (salt-okunur ihlali): ajan devre dışı bırakılır.
- **Şef failover:** Oturum durumu (prompt, tree, tartışma transkripti, plan, sohbet hafızası) CLI'larda değil Kerberos'ta tutulur ve her çağrı tam bağlamla yapılır. Şef hata verirse şeflik kayıpsız biçimde `fallbackChief`'e (Codex) devredilir ve aynı istek yeniden gönderilir.
- **Rollback:** Snapshot'lar `.kerberos/shadow.git` içindeki ayrı bir git deposunda tutulur. Kendi reponuza (branch, index, stash) dokunulmaz ve git olmayan dizinlerde de çalışır. Son snapshot oturumda saklanır, böylece Kerberos yeniden başlatıldıktan sonra da `/undo` yapılabilir.

## Geliştirme

```bash
npm test        # node:test (jail, protokol, state machine, adapter, orchestrator, snapshot, oturumlar, modeller, Telegram hub)
npm run build   # src/ → dist/kerberos.js (esbuild, JSX; sürüm package.json'dan)
```

```
bin/kerberos.js            CLI girişi
src/index.js               bootstrap (config → workspace → oturum → orchestrator → TUI/headless → telegram)
src/config/config.js       .kerberosrc / ~/.kerberos/settings.json / kerberos.config.json / .env
src/adapters/              base-adapter (spawn, idle timeout, hata sınıflandırma, retry) + claude/codex/opencode/agy
src/core/state-machine.js  IDLE → DEBATING (→ AWAITING_ANSWERS →) AWAITING_APPROVAL → BUILDING → DONE (+ ABORTED/ERROR), izin modları
src/core/orchestrator.js   şef-işçi tartışması, görev dağıtımı, failover, auto/plan modları
src/core/sessions.js       oturum deposu, resume, tur kaydı, sohbet hafızası
src/core/models.js         CLI varsayılanları, model katalogları, kota (codex app-server)
src/core/history.js        kalıcı prompt geçmişi
src/core/workspace.js      jail, tree, shadow-git snapshot/rollback
src/core/process-pool.js   eşzamanlılık limiti, killAll
src/core/protocol.js       ARCH_PLAN / görev şemaları (zod), dosya zarfı ayrıştırıcı
src/core/prompts.js        PLANNING_MODE / CODING_MODE rol promptları, geçmiş bloğu
src/remote/telegram.js     Telegram köprüsü (proje başına konu, canlı kart, butonlar)
src/remote/format.js       Telegram kartları, Markdown → Telegram HTML
src/remote/hub.js          çoklu Kerberos için ortak polling hub’ı (IPC), 🐺 lobi konusu
src/ui/                    Ink TUI
```
