# Baza problemów PhraseToGuess — indeks i skróty z czatów

Dokument zbiera **objawy**, **przyczyny** i **rozwiązania** problemów, nad którymi pracowaliśmy w Cursorze, oraz wskazuje **powiązane pliki** w repozytorium.  
Powiązane krótsze notatki w tym samym folderze:

| Plik | Temat |
|------|--------|
| [opoznienie-mint-base-app.md](./opoznienie-mint-base-app.md) | Opóźnienie ~10–15 s przed promptem TX w Base App |
| [ptg-problem-mint-metamask-rozwiazanie.md](./ptg-problem-mint-metamask-rozwiazanie.md) | Wiele popupów MetaMask, zawyżone fee — mint trofeum |

**Lokalizacja kopii na Pulpicie:** `Base dokumentacja\Base Ważne dla AI\` (ten sam zestaw plików).  
W tym folderze jest też zrzut eksploratora Windows z kontekstu zadania: `zrzut-eksplorator-folder-dokumentacja.png`.

---

## Indeks czatów (transkrypty Cursor)

Poniżej skrót tematów według zapisanych sesji (ID w folderze `agent-transcripts` projektu). Pełna treść rozmów jest w plikach `.jsonl` — można je otworzyć w edytorze lub przeszukiwać po frazach.

| Temat | Skrót |
|--------|--------|
| [Przywrócenie konkretnego deploya Vercel](8c270346-7adb-4eed-b3ee-17f942596db2) | Cofnięcie kodu do stanu z URL deploya (`ptg-44rtdlaxu...`). |
| [Ponowne cofnięcie 1:1 + reguły Firebase](fbb3a300-4021-459b-9487-2e3f4120aa71) | Synchronizacja lokalna z deployem; porównanie `database.rules.json`. |
| [Firebase — ostrzeżenie o regułach RTDB](fecfe685-1aeb-414c-9486-97261ab8e6d2) | Konsola Firebase: zbyt szerokie reguły rankingu — analiza i propozycja reguł. |
| [Promocja X / Farcaster / Base — plik „XFARBASE”](9e2abcef-a6a9-4459-9b8d-952862182c5d) | Instrukcja dla agenta social (plik na Pulpicie). |
| [Kontrakt NFT Remix + Pinata](05d64e55-3ce3-4a00-9e86-8b3c8cbb807e) | Nowy kontrakt mintu, Solidity 0.8.30, obrazek, `Kontrakt-nft.sol`. |
| [Snapshot rankingu mintów z CSV](467f6216-ee4c-43d1-b456-82749a29cd94) | Ranking z eksportu Basescan, plik prywatny poza gitem. |
| [Pierwsza pełna analiza projektu](fea58925-8b7b-4081-9d03-e8142a445759) | Przegląd architektury PhraseToGuess. |
| [Naliczenie gier / kalendarz po wygranej](ded41fad-1b57-440c-812a-988435ed97db) | Błąd daty przy miencie następnego dnia — poniżej. |
| [Opóźnienie mintu w Base App ~15 s](02612b94-14d8-4e15-b1ac-00288d97e0d2) | Szczegóły w `opoznienie-mint-base-app.md`. |
| [MetaMask — wiele TX, wysokie fee](3b1a0a59-52e7-46f3-b712-d171c8529c0f) | Szczegóły w `ptg-problem-mint-metamask-rozwiazanie.md`. |
| [Base App — pusty ekran, mint wisi](4212a052-8fc6-4d01-ac59-7413eabd435b) | Timeouty SDK/portfela, RPC, cold start API — poniżej. |
| [Odznaki, UI, kontrakty, wei 0.1$](f79fa3ca-b318-4946-875c-48a542d2fe27) oraz [447dcb18-57b9-48be-ace2-a792fcd8db5a](447dcb18-57b9-48be-ace2-a792fcd8db5a) | Migotanie, mint odznak, adresy kontraktów, komunikaty Failed/Success. |
| [UI: streak, New Category, kontrakty, odświeżanie](a2a87a56-fe27-465d-8dcd-6120c990e479) | Poprawki interfejsu i logiki gry. |
| [Talent Protocol — meta weryfikacji](b72566df-b7e9-4e17-8118-2bc57b691d6f) | Tag `<meta name="talentapp:project_verification" ...>`. |
| [Logo, profil kwadratowy, Base mini app](900ad7dd-2be6-4b49-8f72-e439387a4232) | Grafiki i branding w aplikacji. |

*(ID w nawiasach to nazwy folderów transkryptów w `.cursor/projects/.../agent-transcripts/` — bez `.jsonl`.)*

---

## 1. Kalendarz gier / „wygrałem wczoraj, mint dziś”

**Objaw:** Po wygranej w jednym dniu i miencie następnego dnia gra wpisywała się w **dzień mintu**, a nie w dzień faktycznej rozgrywki.

**Przyczyna:** W Firebase pole `mintCalendar` ustawiane było kluczem `localDateKey()` (dzień transakcji), zamiast dnia gry z `lastPlayed`.

**Rozwiązanie:**

- Przy sukcesie mintu, gdy obowiązuje bonus z `pendingMint`, kluczem dnia jest **`lastPlayed`** z profilu RTDB.
- Zmienna **`myLastPlayedDateKey`** synchronizuje się z profilem i transakcjami wygranej/przegranej, żeby offline też zapisywać właściwy dzień.
- Jawny `update` ścieżki `mintCalendar/<dzień>` używa tego samego dnia co transakcja (`calendarDayWritten`).

**Pliki:** głównie `index.html` (transakcja po mincie, merge kalendarza).

---

## 2. Długi czas do promptu TX w Base App (~10–20 s)

**Objaw:** Po „Mint” długo nic się nie działo; czasem ~15 s — jakby sztuczny limit.

**Przyczyny (skrót):**

- `wallet_switchEthereumChain` wywoływane także przy już ustawionej sieci Base → w WebView pełny timeout.
- Sekwencyjne próby URL-i do `/api/base-jsonrpc` z długimi timeoutami.
- Ciężkie kroki przed `eth_sendTransaction`: zbędne RPC, `eth_requestAccounts` zamiast najpierw `eth_accounts`, blokujący `await update` do Firebase.
- UI czekające na receipt zamiast pokazać hash od razu.

**Rozwiązanie:** Szybki `eth_chainId` i pomijanie switcha na Base; równoległe RPC (`Promise.any` / krótkie timeouty); `getWalletAccountsFast`; cache ceny; `void update` dla niekrytycznych zapisów; wcześniejszy **`onTxHash`**.

**Szczegóły:** [opoznienie-mint-base-app.md](./opoznienie-mint-base-app.md).  
**Pliki:** `index.html`, `api/base-jsonrpc.js`, `api/ptg-broadcast-mint.js`.

---

## 3. MetaMask (desktop) — wiele identycznych TX, wysokie fee

**Objaw:** Po jednym kliknięciu seria okien transakcji; „fee” jak na Ethereum mimo Base.

**Przyczyna:** Wieloetapowy pipeline mintu (fallbacki, relay, drugi przebieg z sufiksem buildera) odpalał **kolejne** `eth_sendTransaction`. Zawyżony lub wielokrotnie estymowany **limit gazu** powiększał koszt w portfelu.

**Rozwiązanie:** Dla trofeum (`publicMint`) ścieżka **jednej** transakcji (strict one-shot), brak retry/fallbacków w trybie zwykłego portfela; lock **`__ptgWalletTxRequestInFlight`**; rozsądny clamp `gas`; odrzucenie użytkownika (`4001`) bez dalszych prób.

**Szczegóły:** [ptg-problem-mint-metamask-rozwiazanie.md](./ptg-problem-mint-metamask-rozwiazanie.md).

---

## 4. Base App — pusty ekran („Loading…”) i wieszający się mint

### 4.1 Pusty ekran, nick / kategorie

**Przyczyna:** `startApp()` czekał na `resolveMiniAppIdentity()`; w WebView **`sdk.context`** i **`eth_accounts`** mogły nie zwrócić odpowiedzi w skończonym czasie → UI zostawał na placeholderach.

**Rozwiązanie:** Helper **`withTimeout(...)`** na `sdk.context` i `eth_accounts`, żeby flow zawsze poszedł dalej (fallback zamiast nieskończonego oczekiwania).

### 4.2 Mint w nieskończoność „Processing…”

**Przyczyna:** `eth_sendTransaction` / `eth_signTransaction` / `eth_requestAccounts` bez limitu czasu — `await` wisi bez końca.

**Rozwiązanie:** **`walletRequestWithTimeout`** na wywołania portfela; **`fetchWithTimeout`** na `/api/base-jsonrpc`, `/api/ptg-badge-voucher`, `/api/ptg-broadcast-mint`.

### 4.3 Nadal długo (~20 s)

**Przyczyny:** Długa lista URL-i RPC i kolejne timeouty; brak cache działającego endpointu; sekwencyjne RPC w `prepareMintTxGasFields`; **dwa** kolejne wywołania serverless (voucher + broadcast) z osobnym **cold startem** (~8–15 s każdy).

**Rozwiązanie:** Krótza lista URL-i, cache, równoległe RPC tam gdzie możliwe, relay-first w embedded, **`warmMintLambdasInBackground()`** (rozgrzewka funkcji po starcie aplikacji).

**Pliki:** `index.html`, `api/ptg-broadcast-mint.js`, `api/ptg-badge-voucher.js`, `api/base-jsonrpc.js`.

---

## 5. Odznaki (PTGBadge), UI, kontrakty

**Typowe problemy z czatów:**

- **Migotanie / stany:** Daily mint nie powinien migać jak odznaka do odebrania; odznaki: szare = niespełnione, pulsujące = do mintu, zwykły kolor = zmintowane. Naprawy w CSS/JS w `index.html`.
- **Wiele odznak do mintu:** Każda kwalifikująca się odznaka powinna mieć animację, nie tylko jedna.
- **Fee / „0.1$”:** Cena w kontrakcie jest w **wei**; UI musi pokazywać spójną wartość i **msg.value** zgodne z kontraktem; błędne wyliczenie powodowało „likely to fail” w portfelu.
- **URI metadanych:** `publicMint` z parametrem URL — wymaga zgodności z tym, czego oczekuje wdrożony kontrakt (zweryfikowane adresy na Basescan).
- **Błędy:** Długi komunikat `CALL_EXCEPTION` / `internal_error` — użytkownikowi tylko krótkie **Failed** / **Success**; ukrycie surowego stacku ethers.
- **Odrzucenie TX:** Nie przenosić ekranu nagle na inny mint (np. trophy) — poprawki nawigacji/stanu po błędzie.

**Pliki:** `index.html`, `api/ptg-badge-voucher.js`, zmienne środowiskowe / adresy kontraktów w konfiguracji i `.env`.

---

## 6. Inne (Firebase, deploy, kontrakty, promocja)

- **Reguły RTDB:** Konsola ostrzegała przed publicznym odczytem/zapisem całej bazy — wymagała weryfikacji `database.rules.json` i modelu danych (`players`, ranking).
- **Rollback deploya:** Przywracanie stanu do konkretnego URL Vercel przez dopasowanie commita w `git` i ewentualnie reguł.
- **Talent Protocol:** Meta tag weryfikacji w `index.html`.
- **Kontrakt NFT / Remix:** Osobny plik Solidity (np. `Kontrakt-nft.sol`), deploy przez Remix + Basescan; cena w wei przy deployu.
- **Ranking z CSV:** Skrypt/pipeline poza gitem — dane wrażliwe nie commitowane.

---

## Mapa plików projektu (najczęściej dotykane przy problemach)

| Plik | Rola |
|------|------|
| `index.html` | Portfel, mint trofeum i odznak, UI, Firebase, Base App SDK |
| `api/base-jsonrpc.js` | Proxy RPC do Base |
| `api/ptg-broadcast-mint.js` | Podpis / broadcast przez backend |
| `api/ptg-badge-voucher.js` | Voucher pod mint odznak |
| `vercel.json` | Trasy API |
| `database.rules.json` | Reguły bezpieczeństwa RTDB |

---

*Ostatnia aktualizacja zbiorcza: 2026-04-14 — spójna z transkryptami w projekcie Cursor i z plikami w folderze `Base Ważne dla AI`.*
